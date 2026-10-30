/**
 * CharacterRunTrace —— **"刚才究竟发生了什么？"**
 *
 * ============================================================================
 *  Trace 不保存完整 Prompt，但必须保存"选择结果"
 * ============================================================================
 * 一次交互之后应当能回答：
 *
 *   · Agent 使用了哪些上下文和记忆？        → contextSectionIds / selectedMemoryIds
 *   · 内部状态是否发生变化？                  → projectionRevisions（前后对比）
 *   · 是否调用了工具，输入结果是什么？        → steps[]（M2.5 只有模型调用这一步）
 *   · 最终产生了什么语言或行为？              → outputEventId
 *   · 为什么这样回答？                        → compilerVersion + sectionRefs
 *
 * 两条硬约束：
 *   1. **内部 Trace Contract 不变**（plan 第 44/50 节）：
 *      不能让 Phoenix/Langfuse 的数据结构反过来成为业务结构。
 *      观测后端挂了、换了，这张表与这个类型都不变。
 *   2. **不写入敏感信息**（plan 第 45 节）：
 *      API Key / Token / 完整系统环境变量 / 数据库凭据一律不进。
 *      对话正文默认也不进——只存 id 与元数据，正文留在 ConversationEvent 里。
 */

import type {
  CharacterId,
  ConversationEventId,
  DomainEventId,
  JobId,
  ProcessorVersion,
  Timestamp,
  TraceId,
} from './ids.ts'

export type TraceStatus = 'running' | 'completed' | 'failed'

/**
 * Trace 里的一步。
 *
 * ============================================================================
 *  M3 第 71 节：完整 Character Run Tree
 * ============================================================================
 * M2.5 只有两个 step（context_compile / model_call）。M3 把一轮对话
 * 拆成计划书第 71 节那张树：
 *
 *     character.run
 *     ├── message.normalize        归一化（谁说的、哪个渠道来的）
 *     ├── actor.resolve            身份解析（external → UserId）
 *     ├── conversation.persist_input   先落账本再调模型
 *     ├── identity.load            Seed 快照（用了哪一版人格）
 *     ├── context.compile          组装上下文
 *     ├── model.generate           模型调用
 *     ├── output.validate          输出校验
 *     ├── conversation.persist_output  落她的回复
 *     └── transport.deliver        对外发送
 *
 * 这样"第 3 步为什么花了 4 秒"这类问题**看一眼 trace 树就能回答**，
 * 而不是靠猜。
 */
export type TraceStepKind =
  | 'message_normalize'
  | 'actor_resolve'
  | 'conversation_persist_input'
  /**
   * M3.5：`ConversationEvent → ConversationObservation`（计划书第 89 / 90 节）。
   * 它让 trace 树能回答"这一轮她到底感知到了什么、从哪来的"。
   */
  | 'observation_adapt'
  | 'identity_load'
  | 'semantic_entry'
  | 'context_compile'
  | 'model_generate'
  | 'output_validate'
  /**
   * M3.5：意图的产生与解析（计划书第 89 / 90 节）。
   *
   * 为什么要把 `intent_create` 与 `intent_resolve` 分开记：
   * "她想做什么"与"那件事变成了什么"是两件事（FC-03）。
   * 混成一步之后，"她说了话但没送出去"与"她压根没想说话"
   * 在 trace 上就无法区分，而那正是未来排查世界交互问题的入口。
   */
  | 'intent_create'
  | 'intent_resolve'
  | 'conversation_persist_output'
  | 'transport_deliver'
  /**
   * M4.5：这一轮她**对世界做了什么**（ADR-030 / ADR-034）。
   *
   * 与 `memory_explicit_write` 分开记，因为两者是两种不同的世界改变：
   * 前者改的是"她知道什么"，这里改的是**外部状态**。
   * 混成一步之后，"她说记住了但没写"与"她动了文件但回复否认"
   * 在 trace 上就无法区分。
   */
  | 'action_dispatch'
  | 'turn_summary'
  /**
   * M5 WP6：这一轮**想起了什么**。
   *
   * 与 `context_compile` 分开记，因为它回答的是另一个问题：
   *   context_compile —— 上下文是怎么组装的（section 名单、裁剪）
   *   memory_recall   —— 召回发生了什么（候选数、被拦下的理由分布、选中了谁、预算账）
   * 混成一步之后，"她没想起来"与"想起来了但没进上下文"在 trace 上就无法区分。
   *
   * ⚠️ 属性里**不许有记忆正文**（只有 id / 计数 / 理由分布）。
   */
  | 'memory_recall'
  /**
   * M5.5 WP5/WP7：这一轮**外面的东西进了多少上下文**。
   *
   * 与 `context_compile` 分开记，因为它回答的是另一个问题：
   *   context_compile   —— 上下文是怎么组装的（section 名单、裁剪）
   *   memory_recall     —— 她想起了什么
   *   external_evidence —— 外面刚告诉她什么、有几条真进了 packet、被哪一种预算裁掉
   *
   * ⚠️ 属性里**不许有摘要正文**（只有 id / 计数 / provider / 标签）。
   * ⚠️ 这一步只在**真的尝试过搜索**时才追加：普通对话的 trace 不因此变长。
   */
  | 'external_evidence'
  /**
   * 实用能力加装（计划书 §2 / §4A 公共第 ⑤ 组）：这一轮**她读到的正文 / 算出的结果**
   * 有多少真的进了 packet、被哪一种预算裁掉。
   *
   * 与 `external_evidence` 同一条纪律，而且理由一样硬（甚至更硬，因为正文更长）：
   * ```text
   *   context_compile    —— 上下文是怎么组装的
   *   external_evidence  —— 外面刚告诉她的**短摘要**进了多少
   *   turn_content       —— 她自己读到的**长正文** / 程序算出的结果进了多少
   * ```
   * ⚠️ 属性里**不许有正文**（只有 contentId / kind / 计数 / 字符数 / 指纹 / 标签）。
   * ⚠️ 只在**真的发生**当轮内容时才追加：普通对话的 trace 不因此变长。
   */
  | 'turn_content'
  /**
   * M6.1 WP4 / ADR-055 `D-55e` ②：**程序生成的记录状态行**的结局。
   *
   * 与 `memory_recall` 分开记，因为它回答的是另一个问题：
   *   memory_recall      —— 召回做了什么（候选 / 排除理由 / 选中了谁）
   *   memory_record_status —— 那一行**状态**最后进了上下文没有（入模 / 被裁 / 未生成）
   *
   * 三态都必须可区分：只有"入模"而没有"被裁 / 未生成"的读数，
   * 会让"这一轮没有依据"与"状态行没被渲染"在事后无法区分。
   *
   * ⚠️ 属性里**不许有状态文本正文**（只有结局 / 计数 / 原因标签）。
   */
  | 'memory_record_status'
  /**
   * M6.1 WP4 / ADR-055 `D-55g`：**回复守卫的观测三态**。
   *
   * `not_run`（观测缺失）与 `passed`（静默通过）必须是两个不同的值 ——
   * 修复前那条静默分支让它们无法区分，而"守卫没运行"恰恰是最容易被当成"没问题"的形态。
   *
   * ⚠️ 属性里只有逐道守卫的状态与计数（`*_status` / `*_count`），**没有回复正文**。
   */
  | 'reply_guard'
  /**
   * M8 / ADR-066 §6.3：**同轮情绪评估的五步观测 + 注入块结局**。
   *
   * 六个 kind 回答六个不同的问题（混成一步会让"没合格"与"被拒"与"没落库"
   * 在 trace 上无法区分——那正是排查"她为什么没反应"需要的三个答案）：
   *   affect_eligibility —— 尾窗里有多少事件、多少合格（谁的消息算数）
   *   affect_proposal    —— 评估器产出了什么（touch/impact 计数、命中规则族 id）
   *   affect_validation  —— 放行口怎么判的（放行/被拒计数、拒码分布）
   *   affect_event       —— 落库结局（新建/幂等命中）
   *   affect_projection  —— 投影结局（revision 迁移或不动）
   *   affect_context     —— 注入块结局（入模/被裁/缺席 + appliedThisTurn——
   *                          reply-truth 的 trace 面，与 event/projection 证据绑定）
   *
   * ⚠️ 属性里**不许有对话正文与情绪数值**（只有 id/计数/拒码/布尔）。
   * ⚠️ 只在 `CHARACTER_AFFECT_CONTEXT_ENABLED` 打开时追加：开关关闭的轮次
   *    trace 不因此变长（M3.5 基线不受影响的机制）。
   */
  | 'affect_eligibility'
  | 'affect_proposal'
  | 'affect_validation'
  | 'affect_event'
  | 'affect_projection'
  | 'affect_context'
  /**
   * M8.5 / WP1 冻结（M85-D14）：**语义慢路径的四步观测**。
   *
   * 语义评估在 completeTurn **之后**才出结果（慢路径——计划 §8.1），
   * 因此这四步由装配层在轮后追加（`appendPostTurnStep`），不在
   * completeTurn 的同轮六步里。四个 kind 回答四个不同的问题：
   *   affect_semantic_discovered —— 扫描面：尾窗里发现了什么
   *     （扫描/不合格/过期/已终结/入队计数）
   *   affect_semantic_dispatched  —— 出站面：模型调用结局
   *     （调用数 / 传输失败按闭集码 / 解析失败计数）
   *   affect_semantic_result      —— 结果面：分类映射的落库结局
   *     （committed / no_impact / 放行口拒绝计数）
   *   affect_semantic_terminal    —— 终态面：非正常终结
   *     （TERMINAL_FAILED / EXPIRED / 取消 / 来源失效计数）
   *
   * ⚠️ 属性里**不许有对话正文、模型输出与情绪数值**（只有计数与闭集码）。
   * ⚠️ 只在 `semantic` 模式且 tick 真的跑过时追加：`rules`/`shadow` 的轮次
   *    trace 不因此变长（M3.5 基线不受影响的机制）。
   */
  | 'affect_semantic_discovered'
  | 'affect_semantic_dispatched'
  | 'affect_semantic_result'
  | 'affect_semantic_terminal'
  /**
   * M9 / WP7（ADR-070 §7 + §10.2）：**信念注入块的结局**。
   *
   * 与 `affect_context` 同构，回答一个问题：这一轮"当前可用判断"最后
   * 进了上下文没有（入模 / 被裁 / 缺席 + 实际入模的 belief id 列表）。
   *
   * `usedBeliefIds` **必须来自 ContextCompiler 的最终 packet**（§10.2 强制细节：
   * 被裁掉的 section 不许标为已使用）——"计划选中"与"实际入模"是两个集合。
   *
   * ⚠️ 属性里**不许有命题正文与来源正文**（只有 id / 计数 / 结局标签）。
   * ⚠️ 只在信念开关打开（构造器真的被装配）时追加：关闭的轮次 trace
   *    不因此变长（M3.5 基线不受影响的机制）。
   */
  | 'belief_context'
  /**
   * M9.1 / ADR-072 D20：**撤销遮蔽的结局**（F-1 修复的审计面）。
   *
   * 回答一个问题：这一轮「被撤证据」在进入上下文之前被怎么处理了
   * （遮蔽了几行 / 整段 Recent 被压制 / 为什么——具名缺口或读取失败）。
   *
   * ⚠️ 属性里**不许有被撤取值与对话正文**（只有计数 / 缺口名 / 结局标签）。
   * ⚠️ 只在遮蔽开关打开（compute 回调真的被装配）时追加：关闭的轮次
   *    trace 不因此变长（M3.5 基线不受影响的机制）。
   */
  | 'withdrawn_masking'
  /**
   * **M11 / WP8（ADR-085 `D21`）**：行为策略注入块的**实际入模**读数。
   *
   * 属性只有 id / 计数 / 结局（`outcome` · `candidate_count` · `used_count` ·
   * `used_refs` · `reached_context` · `dropped_by_context_budget` · `budget_tokens`）
   * —— **没有**策略正文、没有用户原话、没有隐藏推理。
   * ⚠️ `used_refs` **只来自最终 packet**：被裁掉时它是空串（选择 ≠ 入模）。
   */
  | 'adaptive_self_context'
  /** M2.5 的兼容名（既有测试与 Phoenix 面板里已经在用它） */
  | 'model_call'
  | (string & {})

export interface TraceStep {
  /** 步骤类型：见 `TraceStepKind` */
  kind: TraceStepKind
  /** 人类可读描述（不含正文） */
  label: string
  startedAt: Timestamp
  finishedAt?: Timestamp
  status: 'ok' | 'failed'
  /** 结构化元数据：模型名、耗时、token 数、错误码……**不含正文与密钥** */
  attributes: Record<string, string | number | boolean>
}

export interface CharacterRunTrace {
  traceId: TraceId
  characterId: CharacterId

  /**
   * 本次程序运行的 id（**只用于 diagnostics / trace / deployment**）。
   *
   * 计划书第 9 节：它绝对不能作为 CharacterId 或 UserId。
   * 存在这里是为了回答"重启前后是不是同一次运行"这类运维问题。
   */
  runtimeId?: string

  /** 本轮对应的稳定用户身份（**不是** SessionId，计划书第 7 节） */
  userId?: string

  /** 本轮所属会话（可替换，计划书第 8 节） */
  conversationId?: string

  // --- M3.5：感知与意图的语义槽（计划书第 85 / 89 / 90 节）---------------
  /**
   * 本轮她感知到的 Observation 的 id 与类型。
   *
   * 计划书第 85 节明确：SpeechIntent 最终会形成 assistant 事件，
   * 因此**不建** `character_intents` 表；这里只存 id 与类型，
   * 于是"她这一轮是基于哪种感知"可以事后回查，
   * 而不必新建一张只为审计存在的表。
   *
   * 合成轮次（`--dump-prompt` / 无事件的编译）下它们是 `undefined`
   * —— 那时**没有**比编一个更好。
   */
  observationId?: string
  observationType?: string
  /** 本轮产生的 Intent 的 id 与类型（同样只存引用，不存 payload） */
  intentId?: string
  intentType?: string

  // --- 身份快照（计划书第 72/122 节）-------------------------------------
  /**
   * 本轮使用的 Seed 版本。
   *
   * 计划书写得很直接：
   *   > 以后模型回答异常，第一时间检查：用的是不是错误 Seed。
   * 所以这三个字段**每一轮**都必须有。
   */
  seedVersion?: number
  /** 本轮使用的 Seed 指纹（用于检测"库被绕过写入闸改过"） */
  seedHash?: string
  /** 身份来源引用，形如 `character-definition:sumuwei@2` */
  identitySourceRefs: string[]

  /** 触发这一轮的真实对话事件（用户的） */
  inputEventId: ConversationEventId

  /** 组装上下文所用编译器版本 */
  contextCompilerVersion?: string

  /** 实际进入 packet 的 section id（顺序即拼装顺序） */
  contextSectionIds: string[]

  /** 被预算裁掉的 section id（"她是忘了，还是根本没进去"） */
  droppedSectionIds: string[]

  /** 引用了哪些对话事件 / 记忆（M4 起才有 memory id） */
  sourceConversationEventIds: string[]
  selectedMemoryIds: string[]

  /** 各投影在本轮**开始时**的版本（用于回答"这轮开始时她是什么状态"） */
  projectionRevisionsAtStart: Record<string, number>
  /** 各投影在本轮**结束时**的版本 */
  projectionRevisionsAtEnd: Record<string, number>

  /** 本轮产生的领域事件 */
  domainEventIds: DomainEventId[]

  /**
   * M4.5：本轮产生的动作 id（ADR-034 / §20）。
   *
   * 它是"这一轮她做了什么"从 trace 侧的入口：拿到 traceId 或 actionId
   * 任意一个，都能走通到另一侧（ledger 有 `trace_id` 索引）。
   * 合成轮次（`--dump-prompt`）与没有动作的轮次下它为空数组。
   */
  actionIds: string[]

  modelProfile?: string

  outputEventId?: ConversationEventId

  /** 后台任务 id（post-turn analysis） */
  postTurnJobIds: JobId[]

  /** 生成该轮所用 Processor 的版本快照（"这条数据是谁在哪个版本下产生的"） */
  processorVersions: Record<string, ProcessorVersion>

  steps: TraceStep[]

  status: TraceStatus
  /** 失败原因（人类可读，不含正文） */
  error?: string

  startedAt: Timestamp
  finishedAt?: Timestamp
}

/**
 * TraceWriter —— Trace 的落库口。
 *
 * 与 `TelemetryPort`（外发到 Phoenix 等后端）**刻意分开**：
 *   · TraceWriter 是**业务数据**，进我们的库，永远可用。
 *   · TelemetryPort 是**导出**，可以缺失、可以离线、可以换后端。
 * 两者之间由一个 adapter 桥接。观测后端挂了只会丢导出，不会丢证据。
 */
export interface TraceWriter {
  start(trace: CharacterRunTrace): Promise<void>
  finish(
    traceId: TraceId,
    patch: Partial<
      Pick<
        CharacterRunTrace,
        | 'status'
        | 'finishedAt'
        | 'outputEventId'
        | 'error'
        | 'contextCompilerVersion'
        | 'contextSectionIds'
        | 'droppedSectionIds'
        | 'sourceConversationEventIds'
        | 'selectedMemoryIds'
        | 'projectionRevisionsAtEnd'
        | 'domainEventIds'
        | 'postTurnJobIds'
        | 'modelProfile'
        | 'steps'
        | 'processorVersions'
        // M4.5 新增：这一轮她做了什么（ADR-034）
        | 'actionIds'
        // M3 新增
        | 'seedVersion'
        | 'seedHash'
        | 'identitySourceRefs'
        | 'runtimeId'
        | 'userId'
        | 'conversationId'
        // M3.5 新增：感知与意图（计划书第 89 节）
        | 'observationId'
        | 'observationType'
        | 'intentId'
        | 'intentType'
      >
    >
  ): Promise<void>
  get(traceId: TraceId): Promise<CharacterRunTrace | undefined>
  /** 最近若干条（供 `--inspect` 之类的调试入口使用） */
  recent(characterId: CharacterId, limit?: number): Promise<CharacterRunTrace[]>
}
