/**
 * 契约层的公开出口。
 *
 * 领域层只从这里被外部使用——尤其是 `src/infrastructure/*` 与 `src/kernel/*`
 * 的其它部分。这样"领域暴露了哪些东西"是一份可审阅的清单，
 * 而不是散落在十几个文件里的默认导出。
 *
 * ---------------------------------------------------------------------------
 *  M3 新增（计划书第 132 节建议目录的领域侧部分）
 * ---------------------------------------------------------------------------
 *   actor.ts                    —— 身份分层：ActorRef / RuntimeId / Participants
 *   source-authority.ts         —— SourceKind / SourceAuthority / Assistant Fact Firewall
 *   identity-snapshot.ts        —— IdentitySnapshot / SeedVersionRecord / seedSourceRef
 *   ledger-port.ts              —— ConversationLedgerPort（唯一写入契约）
 *   message-normalizer.ts       —— NormalizedConversationInput / 归一化纯逻辑
 *   conversation-integrity.ts   —— 序号 / actor / reply graph / 会话归属 四条规则
 *
 * ---------------------------------------------------------------------------
 *  M3.5 新增（计划书第 6–42 节的七个兼容点）
 * ---------------------------------------------------------------------------
 *   entity.ts                   —— EntityRef / EntityKind / PerspectiveOwnerId（F1/F5）
 *   observation.ts              —— Observation / ConversationObservation（F2）
 *   intent.ts                   —— CharacterIntent / SpeechIntent / CharacterOutput /
 *                                  IntentResolution / IntentResolver（F3/F4）
 *   time.ts                     —— EventTime（recordedAt / occurredAt / logicalTime）（F6）
 *                                  （F7 TriggerKind 在 job.ts）
 *
 * ---------------------------------------------------------------------------
 *  M4 新增（计划书第 21–47 节的领域侧）
 * ---------------------------------------------------------------------------
 *   memory.ts                   —— MemoryRecord / MemoryCandidate / MemoryType /
 *                                  MemoryStatus / MemoryAuthority /
 *                                  MemoryEpistemicStatus / EvidenceRef /
 *                                  CanonicalMemoryKey + 三条失败关闭的断言
 *   memory-predicates.ts        —— predicate 受控登记表（计划书第 19 节
 *                                  "足够稳定即可，不追求世界知识图谱"）
 *
 * M4 的六种 `MEMORY_*` 领域事件类型与它们的 payload 契约住在
 * `domain-event.ts`（与 `TEST_CHARACTER_SIGNAL` 同一个登记模式），
 * 由 `createMemoryDomainEventRegistry()` / `createFullDomainEventRegistry()` 产出。
 *
 * ---------------------------------------------------------------------------
 *  M5 新增（计划书 WP1：召回与上下文装配的契约）
 * ---------------------------------------------------------------------------
 *   recall.ts                   —— RecallRequest / RecallCandidate（检索候选，
 *                                  与 M4 的抽取候选 MemoryCandidate 刻意不同名）/
 *                                  RecallDecision / ContextBundle /
 *                                  RecallExclusionReason + 每个理由的**生产者登记**
 *                                  （拒绝"表达得了但永远触发不了"的死值）
 *
 * ---------------------------------------------------------------------------
 *  M5.1 新增（计划书 WP1：开发者平面契约；按修订记录 R-4 扁平放在 contracts/）
 * ---------------------------------------------------------------------------
 *   developer-query.ts          —— DeveloperQueryService（8 个**只读**方法的 port）/
 *                                  Developer*Dto（每个字段都能落到既有权威形状）/
 *                                  有界游标分页（DeveloperCursorKey / DeveloperPage）/
 *                                  DeveloperLookup（"没找到 / 不许看 / 今天填不出来" 三态）/
 *                                  assertDeveloperExecutionSummary（执行阶梯自洽）/
 *                                  两条**编译期**字段接地证明（凭空造字段 → typecheck 失败）
 *   developer-control.ts        —— ControlCommand / ControlResult / ControlCommandType /
 *                                  CONTROL_COMMAND_FACTS（白名单）/
 *                                  FORBIDDEN_CONTROL_COMMANDS（AT3.5 的禁止清单）/
 *                                  outcome（阶梯）× disposition（终局）× verification（四态）
 *                                  —— **刻意没有 success: boolean**（AT1.2 明令）/
 *                                  controlLadderBooleansOf（阶梯→布尔唯一映射）
 *   observability.ts            —— ObservabilityStage（AT4.2 分类法）+ 每个阶段的生产者登记 /
 *                                  stageOfTraceStepKind（既有一轮 lifecycle → stage 的唯一映射）/
 *                                  ObservabilitySpanInput + spanDurationMs（duration 是算出来的）/
 *                                  AT1.4 敏感数据政策：telemetry attributes 的 **key 级白名单**
 *                                  （与既有**值级**哨兵 assertNoMemoryContentInTrace 分工不同、必须并存）
 *
 * ---------------------------------------------------------------------------
 *  M5.5 新增（ADR-045：外部证据边界；Web Search 的结果只能当"数据"）
 * ---------------------------------------------------------------------------
 *   external-evidence.ts        —— ExternalEvidence（当轮内存，**含 snippet**）/
 *                                  ExternalEvidenceRef（**唯一允许落库 / 进 trace 的形态**，无 snippet；
 *                                  定义在这里，`recall.ts` 只 re-export —— D-14）/
 *                                  buildExternalEvidenceList（失败关闭 + 去重 + 稳定标签 E1…En）/
 *                                  toExternalEvidenceRef（隐私边界的**唯一**通道）/
 *                                  renderExternalEvidenceBlock + buildCitationAppendix（确定性渲染）/
 *                                  unknownCitationLabels（"凭空引用"的**检测**；改写属 WP6）
 *                                  —— 它**不是**召回通道（D-1），也**不**自动落长期记忆（D-7）
 */

export * from './ids.ts'
export * from './actor.ts'
export * from './entity.ts'
export * from './observation.ts'
export * from './intent.ts'
export * from './time.ts'
export * from './character-definition.ts'
export * from './identity-snapshot.ts'
export * from './source-authority.ts'
export * from './conversation-event.ts'
export * from './conversation-integrity.ts'
export * from './ledger-port.ts'
export * from './message-normalizer.ts'
export * from './memory-predicates.ts'
export * from './memory.ts'
export * from './recall.ts'
export * from './domain-event.ts'
export * from './proposal.ts'
export * from './projection.ts'
export * from './processor.ts'
export * from './job.ts'
export * from './context.ts'
export * from './trace.ts'
export * from './developer-query.ts'
export * from './developer-control.ts'
export * from './observability.ts'
export * from './external-evidence.ts'
export * from './rollup.ts'
/* M6.1 WP4 / ADR-055 D-55e/D-55f：程序生成的**记录状态行**（纯契约 + 纯函数） */
export * from './memory-record-status.ts'
/* M6.1 WP4 / ADR-055 D-55g：**回复守卫的观测三态**（具名 + 结构化原因，进 trace） */
export * from './reply-guard.ts'
/* M7 WP2 / ADR-064：Relationship 契约（关系键 / 状态 / 证据等级 / 衰减 / 拒绝码；纯类型 + 纯函数） */
export * from './relationship.ts'
/* M8 WP2 / ADR-066：Affect 契约（Character 级情绪状态 / 证据资格 / 衰减 / 冻结规则标识 / 拒绝码；纯类型 + 纯函数） */
export * from './affect.ts'
/* M8.5 WP3 / ADR-068：Semantic Affect 契约（判定闭集 / reasonCode / span / 上下文快照 / 任务状态机 / 回执编码；detached 只登记不接线） */
export * from './affect-semantic.ts'
/* M9 WP2 / ADR-070：Belief 契约（视角化信念 / 槽位键 / B-REPORTED 白名单 / B-INFERRED 冻结槽位与阈值 / 七事件 payload；纯类型 + 纯函数） */
export * from './belief.ts'
/* post-Lv2 / ADR-110：QQ 主动联系的通知意图 / 实例契约（纯层，无 IO） */
export * from './notification.ts'
/* post-Lv2 / ADR-110 WP3：通知入口（提醒解析）与自主关心的机会预检（纯层，无 IO） */
export * from './notification-intake.ts'
/* post-Lv2 / ADR-110 WP4：角色选择的闭集提案与来源复核（纯层，无 IO） */
export * from './proactive-proposal.ts'
/* Lv4.5 / ADR-131：皮套入口的**系统发起开口**机会预检（15 条具名拒绝；纯层，无 IO） */
export * from './proactive-opening.ts'
/* 多用户补充计划 X0/U1 / ADR-133：作用域三元组、权限矩阵、可见性标签（纯层，无 IO） */
export * from './scope.ts'
/* 多用户补充计划 U1 / WP5：读取面的**唯一**判定（授权 × 归属披露；纯层，无 IO） */
export * from './record-visibility.ts'
