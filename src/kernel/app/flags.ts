/**
 * 功能开关。
 *
 * ============================================================================
 *  plan 第 71/72 节：新架构放在开关下逐步接管
 * ============================================================================
 * M2.5 的硬约束是"M1/M2 行为不得退化"。因此新链路不是"直接替换"，
 * 而是**并列上线**：旧路径继续服务，新路径同时运行并可被验证。
 *
 * 这样做的额外好处：可以随时把新路径关掉，得到 M2 的原行为，
 * 于是"我们有没有改坏什么"这个问题**可以被实测回答**，而不是靠代码审阅。
 *
 * 默认值（M3 起）：
 *   CHARACTER_EVENT_PIPELINE_V2     默认 on  —— 写事实账本不改任何可见行为
 *   CHARACTER_CONTEXT_COMPILER_V1   默认 on  —— 2026-09-16 用户决定：M3 的验收对象必须是新链路
 *   CHARACTER_TELEMETRY_ENABLED     默认 off —— 观测后端一律 opt-in
 *   CHARACTER_SLOW_PATH_ENABLED     默认 on  —— 诊断链路（纯本地，不调模型）
 *   CHARACTER_ACTION_ENABLED        默认 on  —— 动作白名单只有沙箱内 R0/R1
 *
 * `CHARACTER_CONTEXT_COMPILER_V1` 从 off 改成 on 的理由：
 *   M3 要做的是"Seed 稳定、来源隔离、自述经历不污染"——
 *   如果默认还跑 M1 的 prompt 路径，那些测试测的就不是 M2.5 建的这条链。
 *   需要临时回到旧行为时把它显式设为 0。
 */

import type { RiskLevel } from '../action/action-request.ts'
import { RISK_LEVELS } from '../action/action-request.ts'
import { SEARCH_MODES, type SearchMode } from '../action/search-need.ts'
import { isToolDecisionMode, type ToolDecisionMode } from '../action/tool-decision.ts'
/* post-Lv2 / ADR-110 `D14`：QQ 主动联系的模式与**具名策略配置** */
import type { ProactivePolicy } from '../contracts/notification.ts'
import type { ProactiveMode } from '../contracts/notification-intake.ts'
import {
  AFFECT_SEMANTIC_DEFAULT_MODE,
  AFFECT_SEMANTIC_MODES,
  type AffectSemanticMode,
} from '../contracts/affect-semantic.ts'
import { isSemanticMode, type SemanticMode } from '../contracts/recall.ts'

export interface KernelFlags {
  /**
   * 写 ConversationEvent / DomainEvent / Trace（事实与证据层）。
   *
   * ⚠️ **2026-10-07 实测：本字段是惰性的（诊断可见、行为无消费者）** —— 登记册 `R-67`。
   *    `src/**` 里除 `flags.ts` 自己（解析 + `record('event-pipeline-v2', …)`）**没有任何读取者**；
   *    它自 `0347895c`（M2.5 Architecture Foundation）起就是这样，此后 `src/**` 再没有第二个引用。
   *    ⇒ 写事实账本（v2）已是**唯一行为**：把 `CHARACTER_EVENT_PIPELINE_V2=false` **什么都不发生**。
   *    ⚠️ 这正是"一个会撒谎的开关"的形状。删除它属**独立裁定**（会动 flags 的公开形状与
   *    `scripts/kernel-tests-m5.5.1.ts:1138/1143` 的夹具）；本轮**只标注**，不改行为。
   */
  eventPipelineV2: boolean
  /** 用 ContextCompiler 组装主 Agent 的 prompt */
  contextCompilerV1: boolean
  /**
   * 外发遥测（Phoenix 等）。
   *
   * ⚠️ **2026-10-07 实测：本字段只服务诊断行；同一个 env 在别处被真消费** —— 登记册 `R-69`。
   *    行为消费者是 `src/infrastructure/telemetry/port.ts:260` 的 `readTelemetryConfig()`：
   *    它**自己再解析一次** `CHARACTER_TELEMETRY_ENABLED`（同样的 `truthy` 语义）。
   *    ⇒ 不是"开关撒谎"，是**同一配置两处解析**；两处当前语义一致，但**没有机器判据把它们锁在一起**
   *    （改了这里的 `truthy` 不会影响 port.ts 那一份）。
   */
  telemetryEnabled: boolean
  /** 跑 Slow Path（诊断 Processor） */
  slowPathEnabled: boolean
  /** 主链路新增步骤的详细日志 */
  debugContext: boolean

  // --- M4：Memory（计划书第 45 / 53 / 61–63 节）--------------------------
  /**
   * Memory 总开关。
   *
   * 默认 **on**：日常观察与 CI 断言都需要它开启，
   * 而下面那个"后台抽取"的开关才是真正有副作用的那一个。
   */
  memoryEnabled: boolean
  /**
   * 显式记忆路径（记住 / 纠正 / 忘掉）。
   *
   * 默认 **on**：它是 M4 的核心产品价值，且它是**用户驱动**的 ——
   * 不会在用户没要求的时候悄悄写记忆。
   */
  memoryExplicitEnabled: boolean
  /**
   * 后台自动抽取。
   *
   * 默认 **off**，理由与迁移闸同一条：
   * 它会**在没有用户明确要求的情况下**产生真实 Memory，而且它会调模型。
   * 默认开启意味着"某次随手聊天悄悄建了记忆"——
   * 那正是 M4 最需要避免的一类意外（记忆一旦写入就不可回溯修正）。
   *
   * 计划书第 63 节只要求它"不能影响聊天"，没有要求它默认开。
   */
  memoryBackgroundEnabled: boolean
  /** ADR-117: candidate-only LangMem consumer; activation is separate, default off. */
  memoryAutomaticEnabled: boolean
  /** ADR-123: unified model decisions after replies; legacy paths remain available. */
  memoryPostTurnModelEnabled: boolean
  memorySemanticOnlyEnabled: boolean
  /**
   * M4.1：显式路径是否在规则抽取失败后**再问一次模型**（
   * `ChainedContentExtractor([rule, llm])`）。ADR-108 追加：同一开关也装配
   * 规则未命中后的 LLM 意图分类；普通闲聊不能因提到事实就被当成写入要求。
   *
   * 默认 **off**，两个理由：
   *
   *   1. **规则路径必须逐字节不变** —— M4 的 prompt 基线、离线评测与
   *      `m4:verify` §13 都建立在"显式路径是确定性的"之上。
   *   2. **覆盖面与正确性是两件事**。任务书 M4.1 §19 的原话是：
   *      "Coverage 不完美可以接受，False Success 不可接受"。
   *      本轮已经用 `response-truth.ts` 把 False Success 堵死；
   *      扩大覆盖面（LLM 兜底）不是 Hard Gate，可以独立评估。
   *
   * ⚠️ 它**必须被 `main.ts` 真的消费**（选抽取器）。
   *    `CHARACTER_MEMORY_BACKGROUND_ENABLED` 就是因为只被读进 flags、没有任何
   *    消费者，才变成 D3（一个惰性的、看起来能开的开关）。
   *    有一条回归锁守着这一点：`memory-llm-extractor: 开关必须被真的消费`。
   *
   * `LlmContentExtractor` 的输出仍然只生成**候选**，之后照常过
   * Schema 校验 / Authority / 冲突 / 去重 / 放行口 ——
   * LLM 不直接写 memory store（INV-M41-04）。
   */
  memoryLlmExtractorEnabled: boolean
  /**
   * 抽取窗口：一次处理最近几个**完整 turn**（计划书第 45 节）。
   *
   * 计划书明确"不要硬编码一个数字成为领域规则"，因此它是配置。
   * 缺省 3；范围 1..10（超出会被夹住并**不静默**——见 readKernelFlags）。
   *
   * ⚠️ **2026-10-07 实测：本参数是惰性的（诊断可见、行为无消费者）** —— 登记册 `R-68`。
   *    `src/kernel/app/memory/pipeline.ts` **没有** window 参数；新的自动记忆（ADR-117/118）走
   *    **逐事件**流水线、也不传它 ⇒ 目前唯一的读取者是诊断行（`memory-window=…`）。
   *    它是 `28f01a9e`（M4 WP4 后台抽取）那条**至今未接线**的老路径（`M4 D3`）的调参旋钮。
   */
  memoryExtractionWindow: number
  /**
   * importance 阈值（计划书第 53 节的 Value Gate）。
   *
   * 计划书第 45 节对同类参数的态度：配置化，之后通过 Eval 调优。
   *
   * ⚠️ **2026-10-07 实测：同上，惰性**（`R-68`）—— `pipeline.ts` 的 Value Gate **不吃**这个值，
   *    唯一读取者是诊断行（`importance-threshold=…`）。
   */
  memoryImportanceThreshold: number

  // --- M4.5：Action（计划书 §11 / §25 / §61）-----------------------------
  /**
   * 动作总开关（缺省 **on**）。
   *
   * 与 `memoryExplicitEnabled` 默认 on 是同一条理由：
   *   · 它是**用户驱动**的（没人要求时不会自己动世界）
   *   · 它能碰的范围只有 `ACTION_SANDBOX_ROOT` 之内
   *   · 每一件都留下账本，可以事后查证
   *
   * ⚠️ 它**必须被 `main.ts` 真的消费**（决定装不装 actionWriter）。
   *    `CHARACTER_MEMORY_BACKGROUND_ENABLED` 就是因为只被读进 flags、
   *    没有任何消费者，才变成 D3（一个惰性的、看起来能开的开关）。
   *    有一条回归锁守着这一点。
   */
  actionEnabled: boolean
  /**
   * 本次运行允许的最高风险等级（缺省 `R1`）。
   *
   * M4.5 实际运行的能力只有 R0/R1；`R2`/`R3` 的**定义**已经存在，
   * 但没有一个能力声明它们 —— 因此它们无法被执行，
   * 而不是"执行了又被拒"。
   */
  actionMaxRiskLevel: RiskLevel
  /**
   * 沙箱根目录（缺省 `data/action-sandbox`）。
   *
   * 它由**装配层**注入适配器（适配器不自己推导）。
   * "必须在某个根之内"这条约束是不可配置的 —— 只有"根在哪"可配置，
   * 否则 Live Smoke 要么污染真实沙箱、要么不能并行。
   */
  actionSandboxRoot: string

  // --- M5：Recall（计划书 WP6 §AT6.1）------------------------------------
  /**
   * 长期记忆召回总开关（缺省 **on**）。
   *
   * ⚠️ 它**必须被 `main.ts` 真的消费**（装不装召回端口 + 传不传给网关）。
   *    `CHARACTER_MEMORY_BACKGROUND_ENABLED` 就是因为只被读进 flags、
   *    没有任何消费者，才变成 D3（一个惰性的、看起来能开的开关）。
   *
   * 默认 on 的理由与 `memoryExplicitEnabled` 同源：召回是**只读**的 ——
   * 它不会改变任何持久状态，最坏情况是"多想起一条不太相关的旧事实"，
   * 而空召回不产 section 的机制保证了 prompt 基线不受影响。
   */
  recallEnabled: boolean

  /**
   * **M10 / `G-1`**：目标域总开关（缺省 **off**）。
   *
   * ⚠️ 它**必须被 `main.ts` 真的消费**（装不装目标端口 + 传不传给网关）——
   *    与 `recallEnabled` 同一条纪律：只被读进 flags 而没有消费者，就是 **D3**
   *    （一个惰性的、看起来能开的开关）。
   *    回归锁：`m10:test` 的静态检查断言 `src/main.ts` 里真的出现 `goalsEnabled`。
   *
   * 默认 **off** 的理由（与召回**相反**）：召回是**只读**的，而目标域会
   * ① **写**持久状态（目标与承诺的领域事件）、② **真的调模型**（语义理解）
   * ⇒ 属于"要显式开启才算数"的一类。
   *
   * ⚠️ 关着时与接线前**行为逐字相同**：`runGoalTurn` 不注入 ⇒ 网关那条链整段不跑。
   */
  goalsEnabled: boolean

  /**
   * **M10.1 / ADR-086 `D02`**：**约定识别慢路径**的总开关（缺省 **off**）。
   *
   * ```text
   * 关着时：`runConfiguredAgreementTail` **一个端口都不动**（不读窗口、不调模型、不建水位行）
   *        ⇒ 与接线前**行为逐字相同**。
   * 开着时：每轮之后按账本尾部跑**一次**有界窗口的识别（`D02`：有界窗口 + 一次模型调用 + 严格校验），
   *        首次调用先把 cutover 预置成**此刻**的账本序号（`D33`：**不回判历史**）。
   * ```
   *
   * ⚠️ 与 `goalsEnabled` 同一条纪律：**必须被 `main.ts` 真的消费**
   *    （静态回归锁断言 `src/main.ts` 里出现 `agreementEnabled`）。
   */
  agreementEnabled: boolean

  /**
   * Lv4.5 / `P3`：**有限插话**（有来源的角色输出）的开关。
   *
   * ```text
   * 关着时（缺省）：`TurnBridge.interjectionEnabled` 为 false ⇒ `emitCharacterOutput`
   *               一次都不会被调用 ⇒ 与接线前**逐字相同**（零读零写）。
   * 开着时：只读准备那一步会顺带判一次**呼唤**（`detectFastSignal`，含引用/否定/回声负控），
   *        成立才产出一条**有来源、有版本、让出话权**的短句；`stop` **不**产出
   *        （用户要她停，不是要她再说一句）。
   * ```
   *
   * ⚠️ 与 `agreementEnabled` 同一条纪律：**必须被 `main.ts` 真的消费**
   *    （静态回归锁断言 `src/main.ts` 里出现 `interjectionEnabled`）。
   */
  interjectionEnabled: boolean

  /**
   * **M9.5 / WP6（ADR-074 的 D25）**：语义召回（混合相关性排序 + 语义分数）。
   *
   * ```text
   * 默认 **off** —— 这不是保守，而是这一层能改变"她先想到什么"的形状：
   *   · off  ⇒ 不构造编码器、不构造探针、请求**不带** `retrievalPolicyVersion`
   *             ⇒ 与接线前**逐字相同**（`lexical-recency@1`）
   *   · on   ⇒ 装语义探针 + 请求带 `hybrid-relevance@1`
   *             ⇒ 候选**先按相关性排序、再截断**（WP0 的层④缺口修法）
   * ```
   *
   * ⚠️ **必须被 `main.ts` 真的消费**（构造探针 + 选策略版本两处都要）。
   *    `CHARACTER_MEMORY_BACKGROUND_ENABLED` 就是因为只被读进 flags、没有任何消费者，
   *    才变成 D3（一个惰性的、看起来能开的开关）。
   *
   * ⚠️ 打开它**不等于**语义召回已验收，也**不等于**参数经过优化校准：
   *    `PROVISIONAL_HYBRID_POLICY.calibrated` **已是 `true`** —— 那是用户 2026-09-28 裁定
   *    **甲**（"维持等权即冻结"）的产物，**权重与门槛一个数字都没改**
   *    （`{lexical:1, semantic:1, margin:0.5}` + `{minCombined:0.5, minMargin:null}`；
   *    门 `m9.5:retrieval@1` **同时**守"标志为 true"与"权重逐字等于冻结值"）。
   *    ⚠️ 用户逐字边界：**该标志不代表盲测通过，也不代表获准生产激活**。
   *    ⛔ 仍**未裁定**的是 `L-M95-18`（对抗场景下等权会输：诱饵语义 0.99 / 目标 0.01 ⇒ 目标 rank 2）；
   *    A4（reranker）/ A5（ANN）**未做**（见 `M9.5-WP6-Handoff.md` §4）。
   */
  memorySemanticRecallEnabled: boolean

  /**
   * **M9.5 / WP8（计划 §12 WP8）**：语义召回模式 —— `off` / `shadow` / `on`。
   *
   * ```text
   * 只在 `memorySemanticRecallEnabled` 为真时才是这一层的选择；为假时一律 `off`。
   * 缺省 **`shadow`**：先**观察**（算分、记对照），实际排序仍走旧路径 ——
   *   这正是计划 §12 WP12 的"先 shadow 再切换"阶段。
   * ```
   *
   * ⚠️ **非法值失败关闭到 `off`**（最保守的一档），并在启动报告里如实显示
   *    —— 不静默当成 `on`，也不把拼错的模式当成"已启用"。
   */
  memorySemanticMode: SemanticMode

  // --- M5.5：Web Search（ADR-045 `D-12` / ADR-047 `D-31`）------------------
  /**
   * 联网搜索总开关（缺省 **off**）。
   *
   * 与 M4.5 的 `actionEnabled`（缺省 on）**刻意相反**，三条理由：
   *   1. 它会**真实出站**（把用户显式写下的查询发给本机搜索服务，再被转发给上游引擎）；
   *   2. 多一个运行依赖（本机 SearXNG 容器要活着）；
   *   3. `actionEnabled` 能碰的范围只有沙箱之内，而搜索的边界在**本机之外**。
   *
   * 它消费的是**两件**装配动作（少一件都不算打开）：
   *   · 授予 `web:search` 权限
   *   · 构造并注册 `web.search` 的适配器
   * 能力本身**恒登记**（`D-12`）：于是 flag 关闭时用户说"搜一下"会得到一条
   * **可审计的 `permission_denied`**（模型据此如实说"联网没启用"），
   * 而不是"装作没听懂"；同时没有适配器 ⇒ **构造上无法联网**。
   *
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（有一条静态锁守着，D3 的教训）。
   */
  webSearchEnabled: boolean
  /**
   * 外部证据的**独立 token 额度**（缺省 800，有界 0..2000）。
   *
   * ⚠️ 它只在 `webSearchEnabled` 打开时才真的被装配层用：
   *    关闭时装配层传的额度是 **0**（`ContextBudget.externalEvidenceTokens = 0`），
   *    于是"证据进上下文"这条路径在构造上就没有额度可用（ADR-045 `D-16`）。
   */
  webSearchEvidenceTokens: number
  /**
   * M6 / ADR-050：**会话摘要（rolling summary）的独立 token 额度**。
   *
   * 缺省 **0** = "今天不做摘要"这个**真实配置**（不是"忘了填"）——
   * 与 `externalEvidenceTokens` 同一形状：**接线就位、缺省 0、激活另裁**（先例 ADR-048）。
   * 非 0 = 通电：生产装配会把它喂给 `recallBudget.rollupTokens`，
   * 摘要端口才会真的读库、产 section、写 trace（否则构造上就没有额度可用）。
   *
   * ⚠️ 非法值 ⇒ 回落 **0**（= 未激活方向，失败关闭）；不会"猜一个额度"。
   */
  rollupTokens: number
  /**
   * **M11 / ADR-085 `D19`**：反思候选链的总开关（缺省 **off**）。
   *
   * 关闭时：慢路径**不跑**（`D15`：没有触发就不调模型），也不会有候选/审查事件。
   * 与 `goalsEnabled` 同一条纪律：**必须被 `main.ts` 真的消费**
   * （静态回归锁断言 `src/main.ts` 里出现 `reflectionEnabled`）。
   */
  reflectionEnabled: boolean
  /**
   * **M11 / ADR-085 `D19`**：行为调整的写入与注入开关（缺省 **off**）。
   *
   * ⚠️ 与 `reflectionEnabled` **分开**是刻意的：Reflection 开 + Adaptive 关
   * 是**必须可表达**的状态（可审查的反思、但不改行为）—— `D19` 逐字。
   */
  adaptiveSelfEnabled: boolean
  /**
   * **三域应用方案 §4**：反思域的**比较材料**开关（代码缺省 **off**）。
   *
   * ```text
   * off（缺省）⇒ 反思输入与 prompt **逐字节**与今天相同（比较材料 = 0 份）
   * on         ⇒ 对**已获资格**的目标/承诺结局，附加"当时预测 / 实际发生"的辅助比较
   * ```
   *
   * ⚠️ 比较材料**不是证据**：它**不产生** handle、**不产生**独立根、**不触发**反思；
   *    门槛（≥3 根 / ≥2 会话 / 无未解决冲突）**只**看既有来源。
   * ⚠️ 它**多花一次读**（读原始声明事件），但**不多花模型调用**
   *    （反思本来就有且仅有一次模型调用，`D30`）。
   * ⚠️ **必须被 `main.ts` 真的消费**（D3 的教训：只被读进 flags 而没有消费者 = 惰性开关）。
   */
  reflectionOutcomeComparisonEnabled: boolean
  /**
   * **M11 / ADR-085 `D27` / `D34`**：行为策略块的独立额度。
   *
   * ⚠️ 与 `rollupTokens` 同一形状：**接线就位、缺省 0、激活另裁**（先例 ADR-048）。
   * ⚠️⚠️ 它**必须真的**被生产装配喂给 `recallBudget.adaptiveSelfTokens`（`D34`）——
   *    M10 的 `goalTokens` 就是因为**没有**这一步而在生产里永远不可达（`L-M11-10`）。
   * ⚠️ 非法值 ⇒ 回落 **0**（失败关闭），不"猜一个额度"。
   */
  adaptiveSelfTokens: number
  /**
   * **M10.1 / ADR-086 `D09`**：**目标状态块**的额度（M10 遗留的接线缺口）。
   *
   * ⚠️ 为什么要有它：`ContextBudget.goalTokens` **字段早就有**、网关也**确实读它**
   *    （`turn-gateway.ts` 的 `recallBudget.goalTokens`），但装配层**从来没给它赋过值**
   *    ⇒ 生产里 `goal-state` 块**永远被 0 额度丢掉**（`L-M11-10`）。
   *    ⇒ 本 flag 就是那个缺口的补丁：**缺省 0**、有界、非法值回落 0（失败关闭）。
   */
  goalTokens: number
  /**
   * **M10.1 / ADR-086 `D09`**：**约定与结清块**的独立额度（与目标状态块**互不顶替**）。
   *
   * ⚠️ 缺省 **0** = 不注入约定状态/结清事实。⚠️ 非法值 ⇒ 回落 **0**（失败关闭）。
   */
  commitmentTokens: number
  /**
   * 实用能力加装（`Utility-Skills-Execution-Plan-2026-10-04.md` §2 第 5 点）：
   * **四项能力的四个独立开关**，代码缺省全 **off**。
   *
   * 每一项打开 = 三件事同时发生（少一件都不算打开）：
   *   · 装配层**授予**该能力的权限（否则策略第 ③ 步给可审计的 `permission_denied`）
   *   · 装配层**构造**该适配器（否则构造上就没有执行器 / 进程 / 出站）
   *   · 意图检测器**认得**这类明确请求（否则用户说了也不会产生请求）
   *
   * ⚠️ 关闭时的三件事实必须能被分开观测（计划书 §4A 公共第 ① 组）：
   *    能力**仍在登记表里**（恒登记，先例 ADR-045 `D-12`），因此"没启用"是一条
   *    可审计的 `permission_denied`，而不是"装作没听懂"。
   * ⚠️ 这四个开关**必须被 `main.ts` 真的消费**（先例 `D3` 的教训，有静态锁守着）。
   */
  mathCalculateEnabled: boolean
  documentReadEnabled: boolean
  webReadEnabled: boolean
  imageOcrEnabled: boolean
  /** Explicit QQ/avatar image input. Activation is separate from OCR. */
  imageInputEnabled: boolean
  /**
   * 第二批（`Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md` §2.1）
   * —— **本机文件域**的两个独立开关，代码缺省全 **off**。
   *
   * ```text
   * localFileReadEnabled   授予 local-file:list / local-file:read，并构造两个只读适配器
   * localFileWriteEnabled  授予 local-file:write，并构造写入适配器（含恢复副本 + 暂存）
   * ```
   * ⚠️ 为什么读写分两个开关而不是一个：用户对"它能读我的文件"与"它能改我的文件"
   *    是两件不同的事，而"只读全盘、不许写"是一个真实且常见的配置。
   * ⚠️ **旧 `sandbox.file.*` 与 `DEFAULT_GRANTED_PERMISSIONS` 一个字节都不改**：
   *    这两个开关只**追加**新的具名能力（计划书 §2.1 第 1 点）。
   * ⚠️ 这两个开关**必须被 `main.ts` 真的消费**（先例 D3 的教训，有静态锁守着）。
   */
  localFileReadEnabled: boolean
  localFileWriteEnabled: boolean
  /**
   * 第二批：**覆盖前的恢复副本**放在哪里（装配层注入；适配器不自己推导）。
   *
   * ⚠️ 它与动作沙箱是**两个目录**：沙箱是"允许操作的根"，恢复副本是"写入的保险"。
   *    合成一个会让"清空沙箱"顺手把恢复副本也清掉 —— 那正是"不可回收"的形状。
   */
  localFileRecoveryRoot: string
  /**
   * 第二批（§2.2）：**任务自主执行**总开关，代码缺省 **off**。
   *
   * 打开它 = 三件事同时成立：
   * ```text
   * ① 任务形的用户发言会签发一份**内存**任务授权（不新增数据库表）
   * ② 规划器（一次模型调用）给出有限计划，由程序严格校验
   * ③ 计划里的步骤逐步走**既有** Registry / Policy / Gateway / Adapter
   * ```
   * ⚠️ 它**不**决定"能不能读本机文件"：那是 `localFile*Enabled`。
   *    两个开关正交 —— "能自主分步"与"能碰全盘"是两件事。
   */
  taskAutonomyEnabled: boolean
  /** 每任务最多几次行动（计划书 §2.2 候选值 30） */
  taskMaxActions: number
  /** 每任务最多几次规划调用（计划书 §2.2 候选值 6） */
  taskMaxPlans: number
  /** 每任务总时限（毫秒；计划书 §2.2 候选值 10 分钟） */
  taskDeadlineMs: number
  /**
   * **行动预测**总开关（三域应用方案 §2；代码缺省 **off**）。
   *
   * ```text
   * off（缺省）⇒ 任务执行环**不**请求预测：输入、执行顺序与预算**逐字段**与旧档相同
   * on         ⇒ 每份计划在执行前要一次预测；执行后用**真实结果**核对；
   *              核对不通过 ⇒ 停止沿用该结果的后续步骤并重新规划
   * ```
   *
   * ⚠️ 它**会**多花模型调用：预测调用**扣同一份规划预算**
   *    （"不得借新模型调用绕过既有 `maxPlans`"）⇒ 开着它时能重新规划的次数真的变少。
   * ⚠️ 它**不授权**任何东西：预测只拿到闭集状态、具名失败码与既有预算内的读回事实。
   * ⚠️ **必须被 `main.ts` 真的消费**（D3 的教训：只被读进 flags 而没有消费者 = 惰性开关）。
   */
  actionForecastEnabled: boolean
  /** Explicit sandbox write/read simulation routing; default off. */
  simulationPlannerEnabled: boolean
  /**
   * **写前置条件规则**的消费（ADR-151 步骤 D）：**独立开关，缺省 off**。
   *
   * ⚠️ 打开它**不会**凭空产生规则：没有**受信族前置条件声明** ⇒ 没有规则。
   * ⚠️ 否决**只**在"条件**被违反**"时发生（观测值 == `mustNotEqual`）；
   *    条件未知 / 条件成立 / 族不匹配 / 规则不合格 ⇒ **不否决**（回默认顺序）。
   */
  simulationPreconditionRulesEnabled: boolean
  /** PDF extraction/recovery research domain; independent and default off. */
  documentRecoveryEnabled: boolean
  /** Coverage quality proposition (`pdf_text_coverage`); independent, default off, and inert without approved references. */
  documentCoverageEnabled: boolean
  /** Directory of registered coverage references; empty means no reference at all. */
  documentCoverageReferenceDir: string
  /** EBL tool lifecycle and human feedback shadow; independent, default off. */
  epistemicBeliefEnabled: boolean
  epistemicBeliefHumanShadow: boolean
  /** Candidate formal outlet; takes over the matching legacy M9 slot when enabled. */
  epistemicBeliefHumanEnabled: boolean
  /**
   * 预测调用的**硬期限**（毫秒，缺省 20000，有界 1000..60000）。
   *
   * ⚠️ 它**不会**超过任务剩余时限（执行环取两者较小值）。
   * ⚠️ 非法/越界 ⇒ 回落缺省（失败关闭方向）。
   */
  actionForecastTimeoutMs: number
  /**
   * WP1 / ADR-104：**工具决策模式**（代码缺省 `rules`）。
   *
   * ```text
   * `rules` 今天的全部行为：`task-intent` / `local-file-intent` / `utility-intent` /
   *         `weather-news-intent` / 搜索判定器决定"要不要动作"（**逐字节不变**）
   * `role`  角色模型提议：每轮至多一次闭集提案（`answer` / `clarify` / `tools`），
   *         提案经**既有** `validateTaskPlan` 严格解析，之后仍走同一个 Gateway
   * ```
   * 四件必须同时成立才算"role 档真的接上"：
   * ```text
   * ① 决策端口被构造（有 provider、有程序生成的目录文本）
   * ② 关键词**不再**决定资格（`action-turn` 走 role 路径，legacy 路径整段不跑）
   * ③ 提案的 `tools` 分支只能走**既有**任务执行环（预算 / 期限 / 账本 / 归因一个不换）
   * ④ 决策只**提议**：权限、风险上限、目标确定性都不由它决定（ADR-030/031/032）
   * ```
   * ⚠️ 缺省 `rules`；非法值 ⇒ `rules`（失败关闭）。激活属独立裁定（先例 ADR-048）。
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，有静态锁守着）。
   */
  toolDecisionMode: ToolDecisionMode
  /**
   * WP1：决策调用的**硬期限**（毫秒，有界；缺省 8000，与目标理解同档）。
   *
   * ⚠️ 超时就是超时：内核记 `timeout`、**不重试、不回落关键词**
   *    （"失败 ⇒ 如实不动作"，ADR-104 D07）。
   */
  toolDecisionTimeoutMs: number
  /**
   * 第二批：四项业务能力的四个独立开关（计划书 §5 WP2–WP5），代码缺省全 **off**。
   *
   * ```text
   * weatherEnabled       weather.query    固定 Open-Meteo 地理编码 + 预报
   * officeGenerateEnabled office.generate  三个 Python 库，结构化规格生成 Office 文件
   * newsReadEnabled      news.read        RSS/Atom（走既有受限 HTTPS 获取器）
   * browserEnabled       browser.read / browser.operate  固定版本 Playwright MCP sidecar
   * ```
   * ⚠️ 浏览器那一个同时决定**任务级风险额度**：打开它 ⇒ 任务授权拿 R2；
   *    关闭它 ⇒ 即使任务在跑，`browser.operate` 也过不了策略第 ④ 步
   *    （计划书 §4："不为运行浏览器把所有聊天的风险上限统一升为 R2/R3"）。
   */
  weatherEnabled: boolean
  xidianTimetableEnabled: boolean
  officeGenerateEnabled: boolean
  newsReadEnabled: boolean
  browserEnabled: boolean
  /**
   * ★ 2026-10-09 / `ADR-125`：**全工具档**（用户 C 档授权），代码缺省 **false**。
   *
   * ```text
   * browser.mcp   browser:mcp   R3  destructive   按名字调用上游工具表里的任意一个工具
   * ```
   * ⚠️ 它是"任意 MCP 工具入口"（计划书 §3.4 原本明令禁止）**唯一**的开关：
   *    · 关着 ⇒ `browser.mcp` 不在任务能力清单里、权限不授予、任务额度也不抬到 R3，
   *      于是模型连"提出这一步"都做不到（`parseTaskPlan` 会整条丢弃）；
   *    · 开着 ⇒ 该能力可达，且它**能执行任意 JS、读写站点 cookie/本地存储、
   *      抓网络正文、上传任意路径文件、关闭整个浏览器**（见 ADR-125 的风险清单）。
   * ⚠️ **回滚 = 删掉 `.env` 里那一行**（代码缺省就是 false）。
   */
  browserFullTools: boolean
  /** ADR-119: low-cost workflows, scoped library, and fixed arXiv MCP. Default off. */
  workflowSkillsEnabled: boolean
  personalLibraryEnabled: boolean
  arxivResearchEnabled: boolean
  /**
   * ADR-106：桌面查看 / 桌面操作**两个独立开关**，代码缺省都是 **false**。
   *
   * ```text
   * desktopInspectEnabled  desktop.inspect   看一眼当前桌面（窗口 + 可交互元素）
   * desktopOperateEnabled  desktop.operate   闭集动作 click / type（**任务级 R2**）
   * ```
   * ⚠️ 为什么不是一个开关：看桌面（读全部可见文字）与动鼠标键盘（改变用户机器的状态）
   *    是两件严重性不同的事 —— 一个开关会让"只是让她看一眼"顺带把"能动手"也打开。
   * ⚠️ 打开 operate 同时决定**任务级风险额度**（与 `browserEnabled` 同一个数）：
   *    关闭它 ⇒ 即使任务在跑，`desktop.operate` 也过不了策略第 ④ 步。
   */
  desktopInspectEnabled: boolean
  desktopOperateEnabled: boolean
  /** 浏览器 sidecar 的固定地址（只连这一个；`npx ...@latest` 那种入口不存在） */
  browserSidecarUrl: string
  /**
   * ADR-101：由 LG 自己拉起 sidecar。
   *
   * ⚠️ 缺省 `false` ⇒ 行为与 ADR-100 逐字相同（只连固定地址、**从不 spawn**）。
   */
  browserSidecarAutostart: boolean
  /** sidecar 目录（含 `node_modules/@playwright/mcp`）；空串 = 没配（自启动会在装配期拒绝） */
  browserSidecarDir: string
  /** 扩展 token 文件（**凭据**：放被 gitignore 的 private local/，见计划书 §4）；空串 = 没配 */
  browserSidecarTokenFile: string
  /** `--browser` 的值（chrome / msedge） */
  browserSidecarBrowser: string
  /** `--profile-dir-name` 的值；空串 = 不传（让上游自动挑装了扩展的那个） */
  browserSidecarProfile: string
  /**
   * ★ 2026-10-09 / `ADR-125`：传给 sidecar 的 `--caps=` 取值（逗号分隔），
   * 空串 = 不传（上游默认：只有 `core*` 那 25 个工具）。
   *
   * ⚠️ **为什么不是一个布尔**：上游 `filteredTools` 的规则是
   *    `能力以 "core" 开头 ∪ caps 里的能力`，而 CLI 的 `--caps` 帮助文本只列了
   *    `vision, pdf, devtools`（**没有枚举校验**，实测 `--caps=storage` 照样生效）。
   *    ⇒ 取值必须是**闭集校验**的，非法值按失败关闭拒启动，而不是被悄悄忽略
   *      （否则"我开了 storage"会变成一句没有依据的话）。
   * ⚠️ 这一项只影响 sidecar 的**工具表**；"LG 允不允许调用"由 `browserFullTools`
   *    与 `ALLOWED_MCP_TOOLS` 决定 —— 两层都要成立才真的可达。
   */
  browserSidecarCaps: string
  /** 自启动允许的 `@playwright/mcp` 版本（上游换代 ⇒ 拒启动） */
  browserSidecarVersion: string
  /** 自启动允许的入口 `cli.js` 指纹（版本 pin 只覆盖"换了版本"，这条覆盖"同一版本被改过"） */
  browserSidecarEntrySha256: string
  /**
   * 实用能力加装：**当轮内容**那一块的独立额度（缺省 **0**）。
   *
   * ⚠️ 与 `rollupTokens` / `goalTokens` / `commitmentTokens` **同构**：
   *    接线就位、缺省 0、激活另裁（先例 ADR-048）。0 = "今天不注入当轮内容"，
   *    是一个真实配置，不是"忘了填"。隔离验收用 **2000**（计划书 §2 第 3 点）。
   * ⚠️ **非法值 ⇒ 回落 0**（失败关闭方向），不"猜一个额度"。
   */
  turnContentTokens: number
  /**
   * ★ 2026-10-10：**主回复的输出 token 上限**（`max_tokens`），代码缺省 **4096**。
   *
   * ============================================================================
   *  为什么需要它（真机事故，2026-10-10 00:38）
   * ============================================================================
   * ```text
   * 用户："好的试一下清空回收站"
   * → 上游流以 finish_reason="length" 结束
   * → src/providers/chat-stream.ts:28-31 抛 model_stream_finish_length
   * → **整轮失败**（设计如此：宁可不说，也不说半句）
   * → 皮套收到 lg-speech-stream-failed ⇒ postlv2_vtuber_runtime.py:1196 抛 RuntimeError ⇒ 对话链断
   * ```
   * 读回（只读副本，2026-10-10）：那一轮 trace `trc:d5801aa1…` status=failed、
   * error=`model_stream_finish_length`、**25 步停在 `memory_recall`（没有 model_generate 步）**；
   * 对话账 `#886 c43`（用户）与 `#890 c44`（下一条用户）之间**没有任何 assistant_message**
   * ⇒ **零可见产出**。⚠️ 而主回复流**从不解析 `usage`**（`readChatStream` 只累加 `delta.content`，
   * 也没设 `stream_options.include_usage`）⇒ **completion/reasoning 两个读数在这一轮根本不存在**，
   * "思维链吃光"是**最可能但未坐实**的解释（同型读数先例：M5.5.1 R2 的 `completion=800 · reasoning=800`）。
   *
   * ⚠️ 本开关是**A 档（先把眼下堵住）**：把额度抬高，**不是**治本，
   *    也**没有**补上 token 计量（那件事仍未做，见
   *    `docs/post-lv2/Model-Output-Cap-2026-10-10.md`）。
   * 范围 512…16384；非法/越界回落 4096（失败关闭方向 = 不比缺省更宽）。
   */
  replyMaxTokens: number
  /**
   * ★ 续发间隔（毫秒）。**缺省 60_000** —— 与 ADR-129 `D05` 的裁定逐字相同。
   *
   * 存在的理由：把 60s 做成**可注入**，好让**行为级门在秒级**观测到第二条续发
   * （否则一道门要等 60 秒，慢到不可接受）。回滚 = 不设 `CHARACTER_REMINDER_REPEAT_INTERVAL_MS`
   * ⇒ 逐字回到 60_000。范围 1_000…600_000（非法/越界回落缺省）。
   */
  reminderRepeatIntervalMs: number
  /**
   * M7 / ADR-064 D-6：**关系上下文接线**总开关（缺省 **off**）。
   *
   * 它消费的是**三件**装配动作（少一件都不算打开）：
   *   · 启动时播种 RELATIONSHIP_ORIGIN（用户授权基线，ADR-064 U-M7-02）
   *   · 每轮渲染关系注入块（`relationship` section，读 M7 投影的读时视图）
   *   · legacy 状态块退役关系轴（`renderStateBlock` 只剩情绪——无双权威）
   *
   * 缺省 off 的理由与 `webSearchEnabled` 同源：打开它 = 生产 prompt 真实变化
   * + 首次启动会写一条 ORIGIN 域事件。激活属独立裁定（先例 ADR-048），
   * 回滚 = 把它改回 false（legacy 状态块原样渲染，行为回到 M6.1）。
   *
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，有静态锁守着）。
   */
  relationshipContextEnabled: boolean
  /**
   * M8 / ADR-066：**情绪上下文接线**总开关（缺省 **off**）。
   *
   * 它消费的是**四件**装配动作（少一件都不算打开）：
   *   · 启动时播种 AFFECT_ORIGIN（中性起点 0/0 + cutover 边界，M8-D05/D06）
   *     与中断播种恢复（`maybeRunAffectEvaluation` 一个入口三件事）
   *   · 每轮**同轮**情绪评估（beginTurn 后同步跑，无 LLM，ADR-066 §6.3）
   *   · 每轮渲染情绪注入块（`affect` section，优先级 52，读时衰减视图）
   *   · legacy 状态块退役情绪轴（`renderStateBlock` 只剩关系——无双权威，
   *     M8-D12：情绪的域内权威从 M2 legacy 状态移到 Affect 投影）
   *
   * 缺省 off 的理由与 `relationshipContextEnabled` 同源：打开它 = 生产 prompt
   * 真实变化 + 首次启动会写一条 ORIGIN 域事件 + 每轮产生 TOUCH/IMPACT 域事件。
   * 激活属独立裁定（先例 ADR-048/ADR-065），回滚 = 改回 false
   * （legacy 状态块情绪轴原样渲染，行为回到 M7）。
   *
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，有静态锁守着）。
   */
  affectContextEnabled: boolean
  /**
   * M9 / ADR-070：**信念域调度接线**总开关（缺省 **off**）。
   *
   * 它消费的是**三件**装配动作（少一件都不算打开）：
   *   · 启动时播种 BELIEF_ORIGIN（cutover 边界——切换前历史不重放）与
   *     中断播种恢复（`maybeRunBeliefEvaluation` 一个入口三件事）；
   *   · 每轮**同轮**双流评估（beginTurn 后同步跑，无 LLM）：
   *     流 1 `belief-interaction-evaluator`（对话尾窗 → B-INFERRED）+
   *     流 2 `belief-memory-reconciler`（Memory 域事件尾窗 → B-REPORTED
   *     + 依赖失效传播）——两条独立水位，互不阻塞；
   *   · WP7 起渲染信念注入块（`belief` section——本开关打开后 WP7 才接线）。
   *
   * 缺省 off 的理由与 affect 同源：打开它 = 首次启动写一条 ORIGIN 域事件 +
   * 每轮可能产生 BELIEF_* 域事件（新认知的写入面）。激活属独立裁定
   * （先例 ADR-048/065/067），回滚 = 改回 false（已写事件/投影保留，
   * 调度停摆——零新增认知）。
   *
   * ⚠️ turn hook ≠ 新建自主后台任务（计划 WP6 出口原文）：本开关只挂
   *    main.ts 的 open/send 两个既有钩子，没有定时器/轮询/常驻 worker。
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，WP6 门有静态锁）。
   */
  beliefEnabled: boolean
  /** Optional Lv2.5 integration; all three switches default off. */
  storyCognitionEnabled: boolean
  storyChoiceDecisionEnabled: boolean
  storyDailyEnabled: boolean
  /**
   * **Lv4 / `ADR-102` 表达语音**：**逐句表达**（正文旁路 `<lg-speech>` 封套 → 语气指令 + 有限表情）开关。
   * 代码缺省 **false**（**生产未激活**：`.env` 里没有这一行）。回滚 = 删 `.env` 那一行。
   *
   * ⚠️ **2026-10-07 收进本文件**（依据本仓库"开关必须集中在 `flags.ts`"的纪律）：
   *    此前它是 `src/main.ts` 里**三处裸 `process.env.CHARACTER_EXPRESSIVE_SPEECH === 'true'`**
   *    ⇒ 不受开关审计、没有非法值告警、也不出现在 flags 诊断行上。
   *    全项目审计把它登记为 P1：`docs/audit/2026-10-07-full-project-audit.md` §3 / §4 / §9。
   *
   * ⚠️ **语义有一处刻意的放宽**（如实登记，不许当成"逐字等价"）：
   *    旧的裸读只认**小写逐字** `'true'`；现在走 `truthy()` ⇒
   *    `1 / true / yes / on`（大小写不敏感）算**开**，`0 / false / no / off` 算**关**，
   *    未设或空 = 缺省 false，**其他任意字符串回落缺省（false）**。
   *    ⇒ 生产行为不变（`.env` 未设），但"`=TRUE` 以前等于关、现在等于开"。
   *
   * ⚠️ 它消费的是**两件装配动作**（少一件都不算打开）：
   *    `TurnGateway.compileTurn` 的 `expressiveSpeech` 入参（决定装不装 `expressive-speech` section）
   *    + `src/main.ts` 的两处旁路（`CheckedSpeechStream` 与 `decodeExpressiveSpeech`）。
   */
  expressiveSpeechEnabled: boolean
  /**
   * **QQ 出站媒介选择协议**（`CHARACTER_QQ_VOICE_REPLY`，代码缺省 **false**）。
   *
   * ```text
   * off（缺省）= 不挂 QQ 媒介 section、不解析任何封套 ⇒ 旧行为逐字不变
   * on          = 只在 **QQ 入口** 的正式回复里挂一条 `qq-media-reply` section，
   *               并把"文字 / 语音"作为**她的**同轮选择交给既有正文处理链
   * ```
   *
   * ⚠️ 它**不是**"所有回复都变语音"的开关，也**不是**发送权限：
   *    目标、群、API、音色、文件路径仍由受信配置决定（选择只影响这一条的呈现）。
   * ⚠️ 它**必须与 {@link qqVoiceOutputEnabled} 同时开**才算"语音真的可用" ——
   *    只开这一个 ⇒ 不挂 section（没有可选项时不该告诉她有得选）。
   * ⚠️ 它**必须被 `main.ts` 真的消费**（仓库既有教训：只读不接 = 惰性开关）。
   */
  qqVoiceReplyEnabled: boolean
  /**
   * **QQ 语音输出能力声明**（`CHARACTER_QQ_VOICE_OUTPUT`，代码缺省 **false**）。
   *
   * ```text
   * off（缺省）= 这个出口现在**没有**合成/发送语音的能力
   * on          = 外壳已装上受信 TTS 端口（P2 起才有真实实现；P1 只有门里的假端口）
   * ```
   *
   * ⚠️ 为什么"能力声明"要单独一个开关：**核心进程不知道外壳装了哪个 TTS**。
   *    把"能不能发语音"和"要不要给她选择"混成一个开关，会让核心在她面前
   *    假装有这个能力 —— 那正是"程序替她选"之外的另一种不诚实。
   * ⚠️ 声明为 on 而外壳其实没有端口 ⇒ 语音选择会**如实**回落到文字并记
   *    `voice_output_absent`（不是假装发过语音，也不是把稿子念错）。
   */
  qqVoiceOutputEnabled: boolean
  /** Deadline for the optional story decision model. */
  storyChoiceDecisionTimeoutMs: number
  /**
   * M9.1 / ADR-072 D12：**重述复活发射**开关（缺省 **off**）。
   *
   * 它只消费**一件**装配动作：把它传给 memory-validator 的
   * `features.restatementRevivalEnabled`（create 路径的复活标记发射闸）。
   *
   * off（缺省）= 确定性 id 撞上 retracted/superseded 记录时照旧发射无标记的
   * `MEMORY_CREATED`（折叠 no-op）——与 M9 基线**账本同形**；
   * 但 D08 的写入生效检查不受本开关控制：折叠没生效时回报
   * `write_not_effective`（不再假成功）——「要不要复活」可闸，「要不要诚实」不可闸。
   *
   * on = 满足 D03 四条件（状态 ∈ {retracted, superseded} + 开关开 + 证据不相交）
   * 时发射**复活形** CREATE（带 `restatement` 标记），折叠器据此复活该槽位。
   *
   * ⚠️ 它**不是**回滚开关：已提交的复活事件带标记，旧 reducer 不读该字段 ⇒
   *    重放 no-op（发射侧半边）；存储侧原样落库（D07）。回滚 = 改回 false，
   *    新重述回到 no-op + write_not_effective，已复活记录保留。
   *
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，m4:test 有静态锁）。
   */
  memoryRestatementRevivalEnabled: boolean
  /**
   * M9.1 / ADR-072 D21：**撤销遮蔽**（F-1「遗忘后入模泄漏」的装配闸）。
   *
   * on = main.ts 向 turn-gateway 传入 `withdrawnMasking.compute`（D16 端口），
   * 网关在 recentLines 进入任何下游（rollup / compileInput / Recent section）
   * 之前完成遮蔽：命中行换**占位文本**（D18：占位不删除）；端口读取失败或
   * 撤销集带具名缺口 ⇒ **压制整段 Recent**（D19 失败关闭）+ 一步
   * `withdrawn_masking` trace（D20）。
   *
   * off（缺省）= 不传 compute ⇒ recentLines 原样通过 ⇒ prompt 与 M3.5
   * 冻结基线逐字节相同（P 矩阵 off 档的正控基础）。
   *
   * ⚠️ 它闸的是**装配面**，不改变任何已存数据（只读端口 + 编译期替换）。
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，m4:test 有静态锁）。
   */
  withdrawnContextMaskingEnabled: boolean
  /**
   * **post-Lv2 / ADR-109 `D02`**：**入口维度的会话**（`CHARACTER_ENTRY_SCOPED_CONVERSATIONS`，
   * 代码缺省 **false**）。
   *
   * ```text
   * off（缺省）= 会话 id 与 M3 起逐字相同：`dm-<slug>-<userHash>`
   *              ⇒ CLI / QQ / 皮套今天仍然共用同一条近期历史（既有行为不变）
   * on          = 会话 id 追加入口分量：`dm-<slug>-<userHash>-<entry>`
   *              ⇒ 近期对话 / 会话摘要 / 任务上下文按入口分开（长期记忆与认知仍共享）
   * ```
   *
   * ⚠️ **打开它会改变"她看到的近期对话"**：QQ 与皮套从**新的**近期会话开始
   *   （旧混合历史保留原记录与查询入口，但不复制到新会话）—— 见 ADR-109 §2。
   *   因此它是一次**独立裁定的激活**（先例 ADR-048），不是顺手打开的开关。
   * ⚠️ 双入口共存模式（`--coexist`）**要求**它为 on：关着时两路会写进同一条会话，
   *   那是"看起来接上了、其实没隔离"，必须失败关闭（判据在 `main.ts` 的装配里）。
   */
  entryScopedConversations: boolean
  /**
   * **post-Lv2 / ADR-110 `D14`**：QQ 主动联系的模式（`CHARACTER_QQ_PROACTIVE_MODE`，
   * 代码缺省 **`off`**）。
   *
   * ```text
   * off    什么都不做（缺省）：不排期、不评估、不外发
   * shadow 完整产生选择与审计，**不**调用真实发送（靠能力的 `supportsDryRun`）
   * on     许可范围内可自动发送（仍受安静时段 / 额度 / 撤销版本 / 用户暂停约束）
   * ```
   *
   * ⚠️ **非法值 ⇒ `off` + 告警**（失败关闭；理由见读取处的注释）。
   * ⚠️ 前置依赖：主动功能**要求** `CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true`
   *    （关着时两条入口共用一条会话 ⇒ "QQ 的近期窗口只读 QQ 自己的会话"在结构上不成立）。
   *    装配层**拒绝启动**主动调度，而不是"将就着开"。
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，`m4.5:test` 有手写静态锁）。
   */
  qqProactiveMode: ProactiveMode
  /** 原始模式字符串（**只用于诊断/告警**，不参与判定） */
  qqProactiveModeRaw: string
  /**
   * **Lv4.5 / ADR-131**：皮套入口**系统发起开口**的模式
   * （`CHARACTER_AVATAR_OPENING_MODE`，代码缺省 **`off`**）。
   *
   * ```text
   * off    什么都不做（**缺省**）：端口不注入（桥如实报 `opening_capability_absent`）
   * shadow 整条链照跑（预检 ⇒ 依据 ⇒ 一次模型调用 ⇒ 回复守卫 ⇒ 仲裁）但**不出站**
   *        ⇒ 它正好用来取"生成那一段"的真读数，而**不用真的对用户说第一句**
   * on     真的出站（仍受时段 / 空闲下限 / 冷却 / 日额度 / 共享总闸约束）
   * ```
   *
   * ⚠️ **为什么要有它**（`ADR-131` §9 原本写的是"本 ADR 不含任何生产开关"）：
   *    实现完之后发现那是一条**缺口** —— 没有开关意味着**没有激活这一步、也没有配置级回滚**，
   *    而端口与外壳上报器都不带任何判断 ⇒ **重启外壳就等于激活**。
   *    本仓库所有先例的形状都是「代码缺省 off + `.env` 显式打开 + 回滚 = 删那一行」，
   *    这里补齐成同一形状。
   * ⚠️ **非法值 ⇒ `off` + 告警**（失败关闭，与 `qqProactiveMode` 同一条）。
   * ⚠️ 它**必须被 `main.ts` 真的消费**（否则就是"加了开关没接线"）。
   */
  avatarOpeningMode: ProactiveMode
  /** 原始模式字符串（**只用于诊断/告警**，不参与判定） */
  avatarOpeningModeRaw: string
  /**
   * M8.5 / M85-D22：**语义情绪评估模式** —— `rules`（缺省）| `shadow` | `semantic`。
   *
   * 它消费的是**两件**装配动作（少一件都不算打开）：
   *   · `semantic` ⇒ M8 词形路径**让位 IMPACT**（`suppressImpacts`——touch 照旧，
   *     单写入者：语义 worker 是唯一 IMPACT 作者）+ 轮后语义 worker tick；
   *   · 非 `semantic` ⇒ 语义 worker 零读零写（`rules`/`shadow` 都返回具名 no-op；
   *     `shadow` 的隔离采集面是 WP9/WP10 装配，不写生产闸/水位）。
   *
   * ⚠️ **非法值 ⇒ 失败关闭回 `rules` + 告警**（M85-D22 逐字；与
   *    `webSearchMode` 的 `undefined` 刻意不同）：`rules` 本身就是安全缺省
   *    （M8 行为逐字不变），一个拼错的 `CHARACTER_AFFECT_SEMANTIC_MODE=semantc`
   *    回落 rules = 回到已验收行为，不是"用户没批准过的自动升级"。
   *
   * ⚠️ 这个开关**必须被 `main.ts` 真的消费**（D3 的教训，WP8 门有静态锁）。
   * 回滚 = 改回 `rules`：词形 IMPACT 立即恢复；语义侧在途/待办 source 由
   * 启动时的模式切换取消扫面收拢（CANCELLED_BY_MODE_CHANGE 终态闸行）。
   */
  affectSemanticMode: AffectSemanticMode
  /** 原始模式字符串（**只用于诊断/告警**，不参与判定） */
  affectSemanticModeRaw: string
  /**
   * M5.5.1（ADR-049 `D551-2`）：搜索授权模式 —— `explicit`（缺省）| `auto_public`。
   *
   * ⚠️ **非法值 ⇒ `undefined`（= 配置错误 ⇒ 禁止搜索）**，刻意不在这里降级成任何一种模式：
   *    一个拼错的 `CHARACTER_WEB_SEARCH_MODE=auto` 如果静默变成 `auto_public`，
   *    那就是"用户从没批准过的自动出站"。`undefined` 的消费方（`main.ts`）**不授予**
   *    `web:search`、**不构造**适配器与判定器 ⇒ 构造上零出站，并在启动时告警。
   *
   * ⚠️ 总开关 `true` **不等于**授权自动搜索（`D551-2` 逐字）：升级后行为仍与 M5.5 一致，
   *    除非显式把模式改成 `auto_public`。
   */
  webSearchMode: SearchMode | undefined
  /** 原始模式字符串（**只用于诊断/告警**，不参与判定） */
  webSearchModeRaw: string
  /**
   * M5.5.1 S4（用户裁定 A）：**判定调用的硬超时**（毫秒）。
   *
   * 缺省 **25000**（2026-09-20 第三次裁定；原 15000 → 10000），允许 **整数 1000–25000**。⚠️ **非法值 ⇒ `undefined` = 配置错误 ⇒ 禁止搜索**：
   * 既不静默截断到边界，也不回落缺省 —— 裁定逐字："非法值报配置错误并禁止搜索，不静默截断或回落"。
   * **回滚**：显式设 `15000` / `10000` / `5000`（都在允许区间内）。
   *
   * ⚠️ 它**只**管判定调用（含响应体读取），**不**碰 SearXNG 的冻结超时（`D-31` 的 5000ms）——
   *    两者是**两件事**，已知局限里也必须分开记（不能与 `L-M55-12` 混用）。
   */
  webSearchJudgeTimeoutMs: number | undefined
}

const truthy = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function readKernelFlags(env: NodeJS.ProcessEnv = process.env): KernelFlags {
  return {
    eventPipelineV2: truthy(env.CHARACTER_EVENT_PIPELINE_V2, true),
    contextCompilerV1: truthy(env.CHARACTER_CONTEXT_COMPILER_V1, true),
    telemetryEnabled: truthy(env.CHARACTER_TELEMETRY_ENABLED, false),
    slowPathEnabled: truthy(env.CHARACTER_SLOW_PATH_ENABLED, true),
    debugContext: truthy(env.DEBUG_CONTEXT, true),

    memoryEnabled: truthy(env.CHARACTER_MEMORY_ENABLED, true),
    memoryExplicitEnabled: truthy(env.CHARACTER_MEMORY_EXPLICIT_ENABLED, true),
    // 默认 off：见 `KernelFlags.memoryBackgroundEnabled` 的说明
    memoryBackgroundEnabled: truthy(env.CHARACTER_MEMORY_BACKGROUND_ENABLED, false),
    memoryAutomaticEnabled: truthy(env.CHARACTER_MEMORY_AUTOMATIC_ENABLED, false),
    memoryPostTurnModelEnabled: env.CHARACTER_MEMORY_WRITE_MODE === 'post_turn_model',
    memorySemanticOnlyEnabled: env.CHARACTER_MEMORY_RECALL_MODE === 'semantic_only',
    // M4.1：默认 off —— 见 `KernelFlags.memoryLlmExtractorEnabled` 的说明
    memoryLlmExtractorEnabled: truthy(env.CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED, false),
    memoryExtractionWindow: boundedInt(env.MEMORY_EXTRACTION_WINDOW, 3, 1, 10, 'MEMORY_EXTRACTION_WINDOW'),
    memoryImportanceThreshold: boundedFloat(
      env.MEMORY_IMPORTANCE_THRESHOLD,
      0.45,
      0,
      1,
      'MEMORY_IMPORTANCE_THRESHOLD'
    ),

    // M4.5：动作默认 **on** —— 见 `KernelFlags.actionEnabled` 的说明
    actionEnabled: truthy(env.CHARACTER_ACTION_ENABLED, true),
    actionMaxRiskLevel: riskLevelFlag(env.CHARACTER_ACTION_MAX_RISK, 'R1'),
    actionSandboxRoot: env.ACTION_SANDBOX_ROOT ?? 'data/action-sandbox',

    // M5：召回默认 **on** —— 见 `KernelFlags.recallEnabled` 的说明
    recallEnabled: truthy(env.CHARACTER_RECALL_ENABLED, true),

    // M10 / `G-1`：目标域默认 **off** —— 见 `KernelFlags.goalsEnabled` 的说明
    goalsEnabled: truthy(env.CHARACTER_GOALS_ENABLED, false),
    // M10.1 / ADR-086 D02：约定识别的**慢路径**总开关，代码缺省 **off**
    agreementEnabled: truthy(env.CHARACTER_AGREEMENT_ENABLED, false),
    // Lv4.5 / P3：有限插话（有来源的角色输出）总开关，代码缺省 **off**
    interjectionEnabled: truthy(env.CHARACTER_INTERJECTION_ENABLED, false),

    // M9.5 / WP6：语义召回默认 **off** —— 见 `KernelFlags.memorySemanticRecallEnabled` 的说明
    memorySemanticRecallEnabled: truthy(env.CHARACTER_MEMORY_SEMANTIC_ENABLED, false),
    /*
     * M9.5 / WP8：**未设 ⇒ `shadow`**（计划 §12 WP12 的"先观察再切换"）；
     * **非法值 ⇒ `off`**（最保守的一档，失败关闭）。
     * ⚠️ 刻意不把拼错的模式当成 `shadow`：那会让人以为观察已经在跑 ——
     *    而"写了但写错"与"没写"在这里是两件不同的事。
     */
    memorySemanticMode:
      env.CHARACTER_MEMORY_SEMANTIC_MODE === undefined
        ? 'shadow'
        : isSemanticMode(env.CHARACTER_MEMORY_SEMANTIC_MODE)
          ? (env.CHARACTER_MEMORY_SEMANTIC_MODE as SemanticMode)
          : 'off',

    // M5.5：联网搜索默认 **off** —— 见 `KernelFlags.webSearchEnabled` 的说明
    webSearchEnabled: truthy(env.CHARACTER_WEB_SEARCH_ENABLED, false),
    webSearchEvidenceTokens: boundedInt(
      env.CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS,
      800,
      0,
      2000,
      'CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS'
    ),
    // M6 / ADR-050：摘要额度缺省 **0**（= 不激活）；开启属独立裁定（先例 ADR-048）
    rollupTokens: boundedInt(env.CHARACTER_ROLLUP_TOKENS, 0, 0, 2000, 'CHARACTER_ROLLUP_TOKENS'),
    // M11 / ADR-085 D19：反思与行为调整**两个独立开关**，代码缺省均 off
    reflectionEnabled: truthy(env.CHARACTER_REFLECTION_ENABLED, false),
    adaptiveSelfEnabled: truthy(env.CHARACTER_ADAPTIVE_SELF_ENABLED, false),
    /*
     * 三域应用方案 §4：反思域的**比较材料**缺省 **off**。
     * ⚠️ 缺省 off 时反思的输入与 prompt **逐字节**与今天相同。
     * ⚠️ 必须被 `main.ts` 真的消费（只被读进 flags 而没有消费者 = 惰性开关，D3 的教训）。
     */
    reflectionOutcomeComparisonEnabled: truthy(env.CHARACTER_REFLECTION_OUTCOME_COMPARISON_ENABLED, false),
    // M11 / ADR-085 D27+D34：行为策略的独立额度（缺省 0；上限 800 是 D27 的硬上限）
    adaptiveSelfTokens: boundedInt(
      env.CHARACTER_ADAPTIVE_SELF_TOKENS,
      0,
      0,
      800,
      'CHARACTER_ADAPTIVE_SELF_TOKENS'
    ),
    /*
     * M10.1 / ADR-086 D09：**销账 `L-M11-10`** —— 目标状态块额度（缺省 0；上限 800 与 D27 同规）。
     * ⚠️ 这个 flag 的存在就是为了让"目标状态可见"在生产里**真的**成立。
     */
    goalTokens: boundedInt(env.CHARACTER_GOAL_TOKENS, 0, 0, 800, 'CHARACTER_GOAL_TOKENS'),
    /*
     * M10.1 / ADR-086 D09：约定与结清块额度（缺省 0；上限 800 与 D27 同规）。
     * ⚠️ 与 `goalTokens` **互不顶替**：目标状态 ≠ 约定状态。
     */
    commitmentTokens: boundedInt(
      env.CHARACTER_COMMITMENT_TOKENS,
      0,
      0,
      800,
      'CHARACTER_COMMITMENT_TOKENS'
    ),
    /*
     * 实用能力加装（2026-10-04）：四项能力**四个独立开关**，代码缺省全 `off`。
     * ⚠️ 一个开关只管一项能力：把它们合成一个"实用能力总开关"会让
     *    "只启用计算"这种真实配置表达不出来，而"哪一项没启用"正是报告要分列的东西。
     */
    mathCalculateEnabled: truthy(env.CHARACTER_MATH_CALCULATE_ENABLED, false),
    documentReadEnabled: truthy(env.CHARACTER_DOCUMENT_READ_ENABLED, false),
    webReadEnabled: truthy(env.CHARACTER_WEB_READ_ENABLED, false),
    imageOcrEnabled: truthy(env.CHARACTER_IMAGE_OCR_ENABLED, false),
    imageInputEnabled: truthy(env.CHARACTER_IMAGE_INPUT_ENABLED, false),
    /*
     * 第二批（2026-10-04）：**本机文件域**两个开关，缺省全 `off`。
     * ⚠️ 与第一批四项同一条纪律：能力恒登记、权限条件授予、适配器条件构造。
     */
    localFileReadEnabled: truthy(env.CHARACTER_LOCAL_FILE_READ_ENABLED, false),
    localFileWriteEnabled: truthy(env.CHARACTER_LOCAL_FILE_WRITE_ENABLED, false),
    localFileRecoveryRoot: env.LOCAL_FILE_RECOVERY_ROOT ?? 'data/local-file-recovery',
    /*
     * 任务自主执行缺省 **off**（见 `KernelFlags.taskAutonomyEnabled` 的说明）。
     * 三个预算值都**有界**且非法值回落缺省（失败关闭方向：宁可少做，不可失控）。
     */
    taskAutonomyEnabled: truthy(env.CHARACTER_TASK_AUTONOMY_ENABLED, false),
    taskMaxActions: boundedInt(env.CHARACTER_TASK_MAX_ACTIONS, 30, 1, 200, 'CHARACTER_TASK_MAX_ACTIONS'),
    taskMaxPlans: boundedInt(env.CHARACTER_TASK_MAX_PLANS, 6, 1, 50, 'CHARACTER_TASK_MAX_PLANS'),
    taskDeadlineMs: boundedInt(
      env.CHARACTER_TASK_DEADLINE_MS,
      10 * 60 * 1000,
      1_000,
      60 * 60 * 1000,
      'CHARACTER_TASK_DEADLINE_MS'
    ),
    /*
     * 三域应用方案 §2：**行动预测**缺省 **off**。
     * ⚠️ 缺省 off 时任务执行环**一次预测都不请求**（旧档逐字不变）。
     * ⚠️ 它必须被 `main.ts` 真的消费（只被读进 flags 而没有消费者 = 惰性开关，D3 的教训）。
     */
    actionForecastEnabled: truthy(env.CHARACTER_ACTION_FORECAST_ENABLED, false),
    simulationPlannerEnabled: truthy(env.CHARACTER_SIMULATION_PLANNER_ENABLED, false),
    /**
     * **写前置条件规则**的消费（ADR-151 步骤 D）：**独立开关，缺省 off**。
     *
     * ⚠️ 打开它**不会**凭空产生规则：没有**受信族前置条件声明** ⇒ 没有规则 ⇒ 否决整段不发生。
     * ⚠️ 它只允许"条件**被违反**时否决那次写"；条件未知 / 条件成立 / 族不匹配 ⇒ **不否决**。
     * ⚠️ 它必须被 `main.ts` 真的消费（只被读进 flags 而没有消费者 = 惰性开关，D3 的教训）。
     */
    simulationPreconditionRulesEnabled: truthy(env.CHARACTER_SIMULATION_PRECONDITION_RULES_ENABLED, false),
    documentRecoveryEnabled: truthy(env.CHARACTER_DOCUMENT_RECOVERY_ENABLED, false),
    /**
     * 覆盖质量命题（`pdf_text_coverage`）：**独立开关，缺省 off**。
     *
     * ⚠️ 打开它**不会**让覆盖成立：只有**真人复核通过**的参照才可能生效，
     *    没有参照时覆盖恒为 `unknown`（不是"覆盖良好"）。
     * ⚠️ 它与 `documentRecoveryEnabled` 分列：覆盖命题不参与选路，也不改旧"非空"语义。
     */
    documentCoverageEnabled: truthy(env.CHARACTER_DOCUMENT_COVERAGE_ENABLED, false),
    /** 覆盖参照登记目录（缺省空 ⇒ 没有参照 ⇒ 覆盖恒未知）。 */
    documentCoverageReferenceDir: (env.CHARACTER_DOCUMENT_COVERAGE_REFERENCE_DIR ?? '').trim(),
    epistemicBeliefEnabled: truthy(env.CHARACTER_EPISTEMIC_BELIEF_ENABLED, false),
    epistemicBeliefHumanShadow: truthy(env.CHARACTER_EPISTEMIC_BELIEF_HUMAN_SHADOW, false),
    epistemicBeliefHumanEnabled: truthy(env.CHARACTER_EPISTEMIC_BELIEF_HUMAN_ENABLED, false),
    actionForecastTimeoutMs: boundedInt(
      env.CHARACTER_ACTION_FORECAST_TIMEOUT_MS,
      20_000,
      1_000,
      60_000,
      'CHARACTER_ACTION_FORECAST_TIMEOUT_MS'
    ),
    /*
     * WP1 / ADR-104：工具决策模式，代码缺省 `rules`。
     * ⚠️ **未设 ⇒ `rules`**；**非法值 ⇒ `rules`**（与 memorySemanticMode 同规的失败关闭）。
     *    刻意不把拼错的模式当成 role：那会让人以为"她已经自己选工具了"。
     */
    toolDecisionMode:
      env.CHARACTER_TOOL_DECISION_MODE === undefined
        ? 'rules'
        : isToolDecisionMode(env.CHARACTER_TOOL_DECISION_MODE)
          ? env.CHARACTER_TOOL_DECISION_MODE
          : 'rules',
    /* 有界（1s…25s），非法/越界回落缺省 8000（与目标理解同档） */
    toolDecisionTimeoutMs: boundedInt(
      env.CHARACTER_TOOL_DECISION_TIMEOUT_MS,
      8_000,
      1_000,
      25_000,
      'CHARACTER_TOOL_DECISION_TIMEOUT_MS'
    ),
    // 第二批四项业务能力，缺省全 off
    weatherEnabled: truthy(env.CHARACTER_WEATHER_ENABLED, false),
    xidianTimetableEnabled: truthy(env.CHARACTER_XIDIAN_TIMETABLE_ENABLED, false),
    workflowSkillsEnabled: truthy(env.CHARACTER_WORKFLOW_SKILLS_ENABLED, false),
    personalLibraryEnabled: truthy(env.CHARACTER_PERSONAL_LIBRARY_ENABLED, false),
    arxivResearchEnabled: truthy(env.CHARACTER_ARXIV_RESEARCH_ENABLED, false),
    officeGenerateEnabled: truthy(env.CHARACTER_OFFICE_GENERATE_ENABLED, false),
    newsReadEnabled: truthy(env.CHARACTER_NEWS_READ_ENABLED, false),
    browserEnabled: truthy(env.CHARACTER_BROWSER_ENABLED, false),
    /* ADR-125 / 2026-10-09：全工具档（任意工具入口）。代码缺省 **false**。 */
    browserFullTools: truthy(env.CHARACTER_BROWSER_FULL_TOOLS, false),
    /* ADR-106：桌面两档，缺省全 off（打开 = 一次显式的生产激活） */
    desktopInspectEnabled: truthy(env.CHARACTER_DESKTOP_INSPECT_ENABLED, false),
    desktopOperateEnabled: truthy(env.CHARACTER_DESKTOP_OPERATE_ENABLED, false),
    /*
     * post-Lv2 / ADR-110 `D14`：QQ 主动联系的**模式**（`off` 缺省 / `shadow` / `on`）。
     *
     * ⚠️ **非法值 ⇒ `off` + 告警**（失败关闭）。与 `CHARACTER_WEB_SEARCH_MODE` 的
     *    `undefined` 刻意不同，理由与 `CHARACTER_AFFECT_SEMANTIC_MODE` 同源：
     *    `off` 本身就是"什么都不发"的安全缺省，回到它**不是**"用户没批准的自动升级"。
     *    反过来，把拼错的 `charACTER_QQ_PROACTIVE_MODE=onn` 读成 `on` 才是灾难。
     */
    qqProactiveModeRaw: (env.CHARACTER_QQ_PROACTIVE_MODE ?? '').trim(),
    qqProactiveMode: readProactiveMode(env.CHARACTER_QQ_PROACTIVE_MODE),
    avatarOpeningModeRaw: (env.CHARACTER_AVATAR_OPENING_MODE ?? '').trim(),
    avatarOpeningMode: readProactiveMode(env.CHARACTER_AVATAR_OPENING_MODE, 'CHARACTER_AVATAR_OPENING_MODE'),
    /*
     * ⚠️ 缺省用 **`localhost` 而不是 `127.0.0.1`**（2026-10-04 对真 sidecar 实测出来的）。
     *
     * ```text
     * 上游 installHttpTransport 把回环地址**规范化**成 localhost 之后再做 Host 允许名单比对：
     *   addressToString(..., { normalizeLoopback: true })  ⇒ 127.0.0.1 → "localhost"
     *   allowedHosts = [host]                             ⇒ ["localhost:8931"]
     * 然后逐个比对 req.headers.host ⇒ Host: 127.0.0.1:8931 **不在名单里** ⇒ **403**。
     * ```
     * 实测：同一个请求，`http://127.0.0.1:8931/mcp` 回 `403 Access is only allowed at
     * localhost:8931`；换成 `http://localhost:8931/mcp` 回 `200`（initialize）+
     * `202`（notifications/initialized）。⇒ 缺省值必须是 localhost，否则**首连必然 403**。
     */
    browserSidecarUrl: env.CHARACTER_BROWSER_SIDECAR_URL ?? 'http://localhost:8931/mcp',
    /*
     * ========================================================================
     *  ADR-101：由 LG 自己拉起 sidecar（自启动）
     * ========================================================================
     * ⚠️ **代码缺省 `false`** —— 不开时行为与 ADR-100 **逐字相同**：
     *    LG 只是一个连固定地址的 HTTP 客户端，**从不 spawn 任何进程**。
     *
     * 为什么这几项是**配置**而不是硬编码：`authenticity` 与 `可回滚` 都要求
     * "谁来决定让 LG 拥有一个会开浏览器的进程"是**显式**的、且能一行关掉。
     *
     * ⚠️ 目录与 token 文件**没有缺省值**（空字符串 = 没配）。这是刻意的：
     *    自启动的失败必须发生在**装配期**并说清楚（见 ADR-101 §3.5），
     *    而不是等用户第一次用浏览器时才发现"路径是空的"。
     */
    browserSidecarAutostart: truthy(env.CHARACTER_BROWSER_SIDECAR_AUTOSTART, false),
    browserSidecarDir: (env.CHARACTER_BROWSER_SIDECAR_DIR ?? '').trim(),
    browserSidecarTokenFile: (env.CHARACTER_BROWSER_SIDECAR_TOKEN_FILE ?? '').trim(),
    browserSidecarBrowser: (env.CHARACTER_BROWSER_SIDECAR_BROWSER ?? 'chrome').trim(),
    browserSidecarProfile: (env.CHARACTER_BROWSER_SIDECAR_PROFILE ?? '').trim(),
    /* ADR-125：`--caps=`（闭集校验，见 readSidecarCaps）；空串 = 上游默认那 25 个工具 */
    browserSidecarCaps: readSidecarCaps(env.CHARACTER_BROWSER_SIDECAR_CAPS),
    /*
     * 自启动允许的**唯一**版本。上游换代时这里会拒启动（而不是"反正跑起来了"）——
     * 与计划书 §3.4"固定版本 sidecar、不用 npx ...@latest"同一条纪律。
     */
    browserSidecarVersion: (env.CHARACTER_BROWSER_SIDECAR_VERSION ?? '0.0.83').trim(),
    /*
     * 入口 `cli.js` 的 sha256（装好的 `@playwright/mcp@0.0.83` 实测值，1192 字节）。
     * ⚠️ 上游换版本 / 重新发布同一版本时这里会**拒启动** —— 那是刻意的：
     *    宁可让人来更新这一个常量，也不要"悄悄跑了一份没人核对过的入口"。
     */
    browserSidecarEntrySha256: (
      env.CHARACTER_BROWSER_SIDECAR_ENTRY_SHA256 ??
      '70dab09ab9a5bc1943fb78e2655f00af7349f9931073833919f19c5d7d786ad6'
    )
      .trim()
      .toLowerCase(),
    /*
     * 当轮内容的独立额度（缺省 0 = 不注入）。
     *
     * ⚠️ 上限 **2000 → 4000**（2026-10-04，用户「当轮内容额度取值稍微偏高一点最好」）：
     *    原上限与 `webSearchEvidenceTokens` 同规（2000），而生产想给"她读到的正文"更多额度。
     *    抬上限**只放宽一个被校验的范围**，不改任何语义：0 仍是"不注入"、
     *    非法值仍回落 0（`boundedInt` 的失败关闭方向不变）。
     *    ⚠️ 这一段界是 `src` 变更 ⇒ 按计划书 §5「最终完整回归必须对应交付版本」，
     *       改界之后**重跑了一次** `m4.5:ci` 并重新出读数（见验收报告 §3.6 的前后对应）。
     */
    turnContentTokens: boundedInt(
      env.CHARACTER_TURN_CONTENT_TOKENS,
      0,
      0,
      4000,
      'CHARACTER_TURN_CONTENT_TOKENS'
    ),
    /*
     * ★ 2026-10-10：主回复的输出上限（`max_tokens`）。缺省 **4096 = 与改动前逐字相同**。
     * ⚠️ 它只经 `main.ts` 的主回复那一次 `callModelText(..., { maxTokens })` 生效；
     *    私有调用（判据 / 规划 / 决策）各有自己的常量，不受它影响。
     */
    replyMaxTokens: boundedInt(env.CHARACTER_REPLY_MAX_TOKENS, 4096, 512, 16384, 'CHARACTER_REPLY_MAX_TOKENS'),
    /* ★ 续发间隔：缺省 60_000（= 裁定值），只为让行为级门能在秒级跑 */
    reminderRepeatIntervalMs: boundedInt(
      env.CHARACTER_REMINDER_REPEAT_INTERVAL_MS,
      60_000,
      1_000,
      600_000,
      'CHARACTER_REMINDER_REPEAT_INTERVAL_MS'
    ),
    // M7 / ADR-064 D-6：关系上下文缺省 **off** —— 激活属独立裁定（先例 ADR-048）
    relationshipContextEnabled: truthy(env.CHARACTER_RELATIONSHIP_CONTEXT_ENABLED, false),
    // M8 / ADR-066：情绪上下文缺省 **off** —— 激活属独立裁定（先例 ADR-048/ADR-065）
    affectContextEnabled: truthy(env.CHARACTER_AFFECT_CONTEXT_ENABLED, false),
    // M9 / ADR-070：信念域调度缺省 **off** —— 激活属独立裁定（先例 ADR-048/065/067）
    beliefEnabled: truthy(env.CHARACTER_BELIEF_ENABLED, false),
    // Public distribution keeps Lv2.5 opt-in; ordinary chat leaves it unloaded.
    storyCognitionEnabled: truthy(env.CHARACTER_STORY_COGNITION_ENABLED, false),
    storyChoiceDecisionEnabled: truthy(env.CHARACTER_STORY_CHOICE_DECISION_ENABLED, false),
    storyDailyEnabled: truthy(env.CHARACTER_STORY_DAILY_ENABLED, false),
    /*
     * Lv4 / ADR-102：逐句表达，缺省 **false**（生产未激活）。
     * ⚠️ 2026-10-07 从 `main.ts` 的三处裸 `process.env` 收进这里（审计 §3/§4）；
     *    语义放宽（`1/true/yes/on` 都算开）见接口上的字段说明 —— 不是逐字等价。
     */
    expressiveSpeechEnabled: truthy(env.CHARACTER_EXPRESSIVE_SPEECH, false),
    /* QQ 出站媒介：两个开关都缺省 **false**（P1 只接通协议；真实 TTS 是 P2/P3） */
    qqVoiceReplyEnabled: truthy(env.CHARACTER_QQ_VOICE_REPLY, false),
    qqVoiceOutputEnabled: truthy(env.CHARACTER_QQ_VOICE_OUTPUT, false),
    storyChoiceDecisionTimeoutMs: 8_000,
    // M9.1 / ADR-072 D12：重述复活发射缺省 **off** —— 激活属独立裁定（先例 ADR-048/065/067/071）
    memoryRestatementRevivalEnabled: truthy(env.CHARACTER_MEMORY_RESTATEMENT_ENABLED, false),
    withdrawnContextMaskingEnabled: truthy(
      env.CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED,
      false
    ),
    /*
     * post-Lv2 / ADR-109 D02：入口维度的会话，缺省 **false**（激活属独立裁定，先例 ADR-048）。
     * ⚠️ `--coexist` 双入口模式**要求**它为 on（关着时两路共用同一条会话 ⇒ 必须失败关闭）。
     */
    entryScopedConversations: truthy(env.CHARACTER_ENTRY_SCOPED_CONVERSATIONS, false),
    // M8.5 / M85-D22：语义模式缺省 **rules**（M8 行为逐字不变）；非法值失败关闭回 rules
    affectSemanticModeRaw: (env.CHARACTER_AFFECT_SEMANTIC_MODE ?? '').trim(),
    affectSemanticMode: readAffectSemanticMode(env.CHARACTER_AFFECT_SEMANTIC_MODE),
    /*
     * M5.5.1：模式解析。**非法值 → undefined**（配置错误 ⇒ 禁止搜索），见字段说明。
     * 空值/未设 ⇒ 缺省 `explicit`（与 M5.5 逐字一致）。
     */
    webSearchModeRaw: (env.CHARACTER_WEB_SEARCH_MODE ?? '').trim(),
    webSearchMode: readSearchMode(env.CHARACTER_WEB_SEARCH_MODE),
    webSearchJudgeTimeoutMs: readJudgeTimeoutMs(env.CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS),
  }
}

/**
 * 读搜索授权模式。
 *
 * ⚠️ 与 `riskLevelFlag` 的差别是刻意的：风险等级拼错时**收紧到缺省 R1**（安全侧），
 *    而模式拼错时**没有安全缺省可用** —— 因为缺省 `explicit` 仍然允许"显式词形出站"，
 *    而用户写下 `auto` 显然不是想表达 `explicit`。所以这里返回 `undefined`，
 *    由装配层把整条搜索链**关掉**（`D551-2`："非法值 = 配置错误 + 禁止搜索"）。
 */
/**
 * 判定超时的边界。
 *
 * ⚠️ **随裁定更新**（M5.5.1 收口裁定，M5.5.1-Known-Limitations §5）：缺省 10000 → **25000**，
 *    因此**上界同步**抬到 25000 —— 否则新缺省自己就是"非法值"。
 *    回滚：显式设 `15000` / `10000` / `5000`。判定调用预算与 provider 出站硬超时（ADR-054：15000ms）是不同层，不得混用。
 */
export const SEARCH_JUDGE_TIMEOUT_MIN_MS = 1000
export const SEARCH_JUDGE_TIMEOUT_MAX_MS = 25_000
export const SEARCH_JUDGE_TIMEOUT_DEFAULT_MS = 25_000

/**
 * 读判定调用的硬超时（用户裁定 A）。
 *
 * ⚠️ 与 `boundedInt`（越界**夹住**）**刻意不同**：裁定要求"非法值报配置错误并禁止搜索，
 *    不静默截断或回落"。一个被夹到 10000 的 `20000` 会让运维以为配置生效了 ——
 *    而它实际请求的是另一个预算。这里返回 `undefined`，由装配层把整条搜索链关掉。
 */
function readJudgeTimeoutMs(raw: string | undefined): number | undefined {
  const value = (raw ?? "").trim()
  if (value === "") return SEARCH_JUDGE_TIMEOUT_DEFAULT_MS
  const parsed = Number(value)
  if (
    !Number.isInteger(parsed) ||
    parsed < SEARCH_JUDGE_TIMEOUT_MIN_MS ||
    parsed > SEARCH_JUDGE_TIMEOUT_MAX_MS
  ) {
    warnFlag("CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS", value, `必须是 ${SEARCH_JUDGE_TIMEOUT_MIN_MS}..${SEARCH_JUDGE_TIMEOUT_MAX_MS} 的整数`)
    console.warn(
      `[m551] 配置错误：CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS=${JSON.stringify(value)} 不是 ` +
        `${SEARCH_JUDGE_TIMEOUT_MIN_MS}..${SEARCH_JUDGE_TIMEOUT_MAX_MS} 的整数 ⇒ ` +
        "**不授予 web:search、不构造适配器与判定器**（不静默截断、不回落缺省）"
    )
    return undefined
  }
  return parsed
}

function readSearchMode(raw: string | undefined): SearchMode | undefined {
  const value = (raw ?? '').trim()
  if (value === '') return 'explicit'
  if ((SEARCH_MODES as readonly string[]).includes(value)) return value as SearchMode
  warnFlag('CHARACTER_WEB_SEARCH_MODE', value, `不是 ${SEARCH_MODES.join('/')}，配置错误 ⇒ 禁止搜索`)
  console.warn(
    `[m551] 配置错误：CHARACTER_WEB_SEARCH_MODE=${JSON.stringify(raw)} 不是 ` +
      `${SEARCH_MODES.join('/')} 之一 ⇒ **不授予 web:search、不构造适配器与判定器**（不静默降级）`
  )
  return undefined
}

/**
 * 读语义情绪评估模式（M8.5 / M85-D22）。
 *
 * ⚠️ 与 `readSearchMode` 的差别是刻意的：搜索模式拼错时**没有安全缺省**
 *    （`explicit` 仍允许出站），所以回 `undefined` 关整条链；而语义模式的
 *    缺省 `rules` **本身就是安全侧**（M8 已验收行为），所以非法值回落
 *    `rules` + 告警——失败关闭的方向是"回到词形路径"，不是"猜一个模式"。
 * 空值/未设 ⇒ 缺省 `rules`（升级后行为与 M8 逐字一致——M85-D22 前置）。
 */
function readAffectSemanticMode(raw: string | undefined): AffectSemanticMode {
  const value = (raw ?? '').trim()
  if (value === '') return AFFECT_SEMANTIC_DEFAULT_MODE
  if ((AFFECT_SEMANTIC_MODES as readonly string[]).includes(value)) {
    return value as AffectSemanticMode
  }
  console.warn(
    `[m8.5] 配置错误：CHARACTER_AFFECT_SEMANTIC_MODE=${JSON.stringify(raw)} 不是 ` +
      `${AFFECT_SEMANTIC_MODES.join('/')} 之一 ⇒ **失败关闭回 ${AFFECT_SEMANTIC_DEFAULT_MODE}**` +
      `（M8 词形路径逐字不变；不静默猜一个模式）`
  )
  return AFFECT_SEMANTIC_DEFAULT_MODE
}

/**
 * 读风险等级上限。
 *
 * ⚠️ 越界/拼错时**退回缺省并告警**，而不是当成"没有上限"：
 *    一个拼错的 `CHARACTER_ACTION_MAX_RISK=R9` 如果被解释成"无限制"，
 *    那正是最危险的方向。安全的那一侧是**收紧**。
 */
function riskLevelFlag(raw: string | undefined, fallback: RiskLevel): RiskLevel {
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toUpperCase()
  if ((RISK_LEVELS as readonly string[]).includes(normalized)) return normalized as RiskLevel
  warnFlag('CHARACTER_ACTION_MAX_RISK', raw, `不是 ${RISK_LEVELS.join('/')}，改用缺省 ${fallback}`)
  return fallback
}

/**
 * ★ 2026-10-09 / `ADR-125`：读 `--caps=` 的取值（**闭集**，逗号分隔）。
 *
 * ⚠️ 闭集不是"抄文档"：这是从装好的 `@playwright/mcp@0.0.83` 里读出来的
 *    能力取值全集（`core` 恒开、不需要也不能由这一项打开，所以不在表里）。
 * ⚠️ **非法名字逐个丢弃并告警**（失败关闭方向 = 少开，不是多开）。
 *    刻意**不**因为一个拼错的名字而拒启动：`--caps` 坏掉只会少几个工具，
 *    而"起不来"会牵连整条浏览器链路（其余能力不受影响）——
 *    两种失败都要如实说出来，这里选的是"能起、少开、告警"。
 */
export const BROWSER_SIDECAR_CAPS_KNOWN: readonly string[] = [
  'config',
  'devtools',
  'network',
  'pdf',
  'storage',
  'testing',
  'vision',
]

function readSidecarCaps(raw: string | undefined): string {
  const text = (raw ?? '').trim()
  if (text === '') return ''
  const kept: string[] = []
  for (const part of text.split(',')) {
    const name = part.trim().toLowerCase()
    if (name === '') continue
    if (!BROWSER_SIDECAR_CAPS_KNOWN.includes(name)) {
      warnFlag(
        'CHARACTER_BROWSER_SIDECAR_CAPS',
        text,
        `「${name}」不是已知能力（${BROWSER_SIDECAR_CAPS_KNOWN.join('/')}），已丢弃`
      )
      continue
    }
    if (!kept.includes(name)) kept.push(name)
  }
  return kept.join(',')
}

/**
 * 读 QQ 主动联系的模式（post-Lv2 / ADR-110 `D14`）。
 *
 * ⚠️ **非法值 ⇒ `off` + 告警**（失败关闭）。刻意不返回 `undefined`：
 *    `off` 就是"什么都不发"的安全缺省，回落它不构成"用户没批准的自动升级"。
 */
function readProactiveMode(raw: string | undefined, name = 'CHARACTER_QQ_PROACTIVE_MODE'): ProactiveMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return 'off'
  if (value === 'off' || value === 'shadow' || value === 'on') return value
  warnFlag(name, raw ?? '', '不是 off/shadow/on，失败关闭回 off')
  return 'off'
}

/**
 * QQ 主动联系的**具名策略配置**（ADR-110 `D14`）。
 *
 * ⚠️ 一个具名配置，**不**为每项规则建设新的管理服务；所有值都是**待冻结的建议值**，
 *    且**代码缺省全在安全侧**（时段短、额度小、超时短）。
 * ⚠️ 时区**不继承宿主机**：缺省写死 `Asia/Shanghai`（计划 §6 逐字）。
 */
export function readProactivePolicy(env: NodeJS.ProcessEnv = process.env): ProactivePolicy {
  const timeZone = (env.CHARACTER_QQ_PROACTIVE_TIMEZONE ?? '').trim() || 'Asia/Shanghai'
  const startHour = boundedInt(env.CHARACTER_QQ_PROACTIVE_START_HOUR, 9, 0, 23, 'CHARACTER_QQ_PROACTIVE_START_HOUR')
  const endHour = boundedInt(env.CHARACTER_QQ_PROACTIVE_END_HOUR, 22, 1, 24, 'CHARACTER_QQ_PROACTIVE_END_HOUR')
  return {
    timeZone,
    activeWindow: { timeZone, startHour, endHour },
    opportunityIntervalMs:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_INTERVAL_MIN, 30, 5, 24 * 60, 'CHARACTER_QQ_PROACTIVE_INTERVAL_MIN') * 60_000,
    idleMs:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_IDLE_MIN, 120, 10, 7 * 24 * 60, 'CHARACTER_QQ_PROACTIVE_IDLE_MIN') * 60_000,
    careCooldownMs:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_COOLDOWN_MIN, 180, 10, 7 * 24 * 60, 'CHARACTER_QQ_PROACTIVE_COOLDOWN_MIN') * 60_000,
    maxCarePerDay:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_MAX_CARE_PER_DAY, 2, 0, 24, 'CHARACTER_QQ_PROACTIVE_MAX_CARE_PER_DAY'),
    maxProactiveMessagesPerDay:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_MAX_MESSAGES_PER_DAY, 10, 0, 200, 'CHARACTER_QQ_PROACTIVE_MAX_MESSAGES_PER_DAY'),
    reminderGraceMs:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_REMINDER_GRACE_MIN, 30, 1, 24 * 60, 'CHARACTER_QQ_PROACTIVE_REMINDER_GRACE_MIN') * 60_000,
    evaluationTimeoutMs:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_EVAL_TIMEOUT_MS, 15_000, 1_000, 60_000, 'CHARACTER_QQ_PROACTIVE_EVAL_TIMEOUT_MS'),
    maxPendingReminders:
      boundedInt(env.CHARACTER_QQ_PROACTIVE_MAX_PENDING, 20, 1, 200, 'CHARACTER_QQ_PROACTIVE_MAX_PENDING'),
    /*
     * ADR-131 `D15` / `D17`：皮套入口的**系统发起开口**。
     *
     * ⚠️ 四个都取**安全侧**：下限/冷却/额度是"越保守越好"，
     *    期限是"越短越不卡用户"（主动开口发生在**用户在线**时）。
     */
    openingMinIdleMs:
      boundedInt(env.CHARACTER_AVATAR_OPENING_MIN_IDLE_MIN, 3, 1, 24 * 60, 'CHARACTER_AVATAR_OPENING_MIN_IDLE_MIN') * 60_000,
    openingCooldownMs:
      boundedInt(env.CHARACTER_AVATAR_OPENING_COOLDOWN_MIN, 30, 1, 7 * 24 * 60, 'CHARACTER_AVATAR_OPENING_COOLDOWN_MIN') * 60_000,
    maxOpeningsPerDay:
      boundedInt(env.CHARACTER_AVATAR_OPENING_MAX_PER_DAY, 4, 0, 24, 'CHARACTER_AVATAR_OPENING_MAX_PER_DAY'),
    openingDeadlineMs:
      boundedInt(env.CHARACTER_AVATAR_OPENING_DEADLINE_MS, 8_000, 1_000, 60_000, 'CHARACTER_AVATAR_OPENING_DEADLINE_MS'),
  }
}

/**
 * 读一个有界整数。
 *
 * ⚠️ 越界时**夹住并在 debug 下说出来**，而不是静默接受或静默忽略。
 *
 * 计划书第 45 节说这个窗口"不要硬编码成领域规则"，
 * 但没说不该有上界。上界是必要的：一个 `MEMORY_EXTRACTION_WINDOW=10000`
 * 会把整个历史塞进一次 prompt。
 *
 * 而"夹住"必须**可被发现**：静默夹住会让运维以为配置生效了。
 * 因此这里在 `M4_DEBUG_MEMORY=1` 时打印一条警告。
 */
function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warnFlag(name, raw, `不是整数，改用缺省 ${fallback}`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(max, Math.max(min, parsed))
    warnFlag(name, raw, `超出 [${min}, ${max}]，夹到 ${clamped}`)
    return clamped
  }
  return parsed
}

function boundedFloat(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    warnFlag(name, raw, `不是有限数字，改用缺省 ${fallback}`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(max, Math.max(min, parsed))
    warnFlag(name, raw, `超出 [${min}, ${max}]，夹到 ${clamped}`)
    return clamped
  }
  return parsed
}

function warnFlag(name: string, raw: string, why: string): void {
  if (process.env.M4_DEBUG_MEMORY === '1') {
    console.warn(`[m4] 配置 ${name}=${JSON.stringify(raw)} ${why}`)
  }
}

/** 一行式摘要，启动时打进日志（"这次到底开了哪些新东西"必须一眼可见） */
export function describeKernelFlags(flags: KernelFlags): string {
  const on: string[] = []
  const off: string[] = []
  const record = (name: string, value: boolean) => (value ? on.push(name) : off.push(name))
  record('event-pipeline-v2', flags.eventPipelineV2)
  record('context-compiler-v1', flags.contextCompilerV1)
  record('image-input', flags.imageInputEnabled)
  record('telemetry', flags.telemetryEnabled)
  record('slow-path', flags.slowPathEnabled)
  // M4：三个 memory 开关分开报 —— "后台抽取是否在跑"是排查记忆增长的第一现场
  record('memory', flags.memoryEnabled)
  record('memory-explicit', flags.memoryExplicitEnabled)
  /*
   * M4.1：这两行现在**各带一句状态注释**，因为它们的性质不同：
   *
   *   memory-background   —— 读进来只为**如实告警**。它没有任何消费者，
   *                          打开它**不会**启用自动抽取（那是 D3）。
   *   memory-llm-extractor—— 真的被 `main.ts` 消费（选抽取器）。
   *
   * 把两者一起打在 flags 行上，是为了让"哪个开关是真的"一眼可见 ——
   * 否则下一个人会以为它们等价，而这正是 D3 的成因。
   */
  record('memory-background(NOT-WIRED)', flags.memoryBackgroundEnabled)
  record('memory-automatic(langmem)', flags.memoryAutomaticEnabled)
  record('memory-write(post-turn-model)', flags.memoryPostTurnModelEnabled)
  record('memory-recall(semantic-only)', flags.memorySemanticOnlyEnabled)
  record('memory-llm-extractor', flags.memoryLlmExtractorEnabled)
  // M4.5：动作是否真的在这条链上（"装了没有"必须一眼可见）
  record(`action(${flags.actionMaxRiskLevel})`, flags.actionEnabled)
  // M5：召回是否真的在这条链上（它决定装不装召回端口 —— 与上面同一条纪律）
  record('recall', flags.recallEnabled)
  // M10 / `G-1`：目标域是否真的在这条链上（它决定装不装目标端口）
  record('goals', flags.goalsEnabled)
  // M10.1 / ADR-086 D02：约定识别慢路径（它决定跑不跑那次有界窗口的模型调用）
  record('agreement', flags.agreementEnabled)
  // Lv4.5 / P3：有限插话（它决定"呼唤"会不会真的产出一条短句）
  record('interjection', flags.interjectionEnabled)
  // Lv4 / ADR-102：逐句表达（它决定装不装表达 section、走不走表达旁路）
  record('expressive-speech', flags.expressiveSpeechEnabled)
  /*
   * post-Lv2 / QQ 媒介选择（P1）：**两行**，理由与前面几行一样 ——
   * "协议开了"与"语音真的可用"是两件事，合成一个会让"只开协议"看起来像"已经能发语音"。
   */
  record('qq-voice-reply', flags.qqVoiceReplyEnabled)
  record(`qq-voice-output`, flags.qqVoiceOutputEnabled && flags.qqVoiceReplyEnabled)
  // M9.5 / WP6：语义召回（它决定装不装探针 + 选不选混合策略版本）
  record('memory-semantic-recall', flags.memorySemanticRecallEnabled)
  // M9.5 / WP8：模式（"观察还是切换"必须一眼可见）
  record(`memory-semantic-mode(${flags.memorySemanticMode})`, flags.memorySemanticMode !== 'off')
  // M5.5：联网搜索（"装了没有"必须一眼可见：它决定授不授权、装不装适配器）
  record('web-search', flags.webSearchEnabled)
  // M5.5.1：模式必须可见 —— 否则"总开关开着但是 explicit"与"auto_public"看起来一样
  const modeLabel =
    flags.webSearchMode === undefined ? 'INVALID(禁止搜索)' : flags.webSearchMode
  record(`web-search-mode(${modeLabel})`, flags.webSearchEnabled && flags.webSearchMode !== undefined)
  // M5.5.1 S4：判定超时的**实际生效值必须可见**（裁定逐字："日志必须显示实际生效值"）
  const judgeTimeoutLabel =
    flags.webSearchJudgeTimeoutMs === undefined
      ? "INVALID(禁止搜索)"
      : String(flags.webSearchJudgeTimeoutMs)
  record(`web-search-judge-timeout(${judgeTimeoutLabel}ms)`, flags.webSearchJudgeTimeoutMs !== undefined)
  /*
   * 第二批（2026-10-04）：**本机文件域 + 任务执行环 + 四项业务能力**。
   * ⚠️ 一个开关一行，理由与第一批四项一样："哪一项没启用"正是报告要分列的东西；
   *    合成一个"实用能力总开关"会让"只读全盘、不许写"这种真实配置表达不出来。
   * ⚠️ 本机文件域的两项用 `local-file-read` / `local-file-write` 两个名字 ——
   *    它们对应两件不同的事（能看 ≠ 能改）。
   */
  record('local-file-read', flags.localFileReadEnabled)
  record('local-file-write', flags.localFileWriteEnabled)
  record('task-autonomy', flags.taskAutonomyEnabled)
  /*
   * WP1 / ADR-104：模式必须一眼可见 —— 否则"接上决策端口但模式是 rules"
   * 与"role"在启动日志上看起来一样（先例：`web-search-mode` 的那一行）。
   */
  record(`tool-decision-mode(${flags.toolDecisionMode})`, flags.toolDecisionMode === 'role')
  record('weather', flags.weatherEnabled)
  record('xidian-timetable', flags.xidianTimetableEnabled)
  record('workflow-skills', flags.workflowSkillsEnabled)
  record('personal-library', flags.personalLibraryEnabled)
  record('arxiv-research', flags.arxivResearchEnabled)
  record('office-generate', flags.officeGenerateEnabled)
  record('news-read', flags.newsReadEnabled)
  record('browser', flags.browserEnabled)
  record(`browser-full-tools(caps=${flags.browserSidecarCaps === '' ? '(默认)' : flags.browserSidecarCaps})`, flags.browserFullTools)
  /* ADR-106：两档分别记录 —— 合成一行会让"只看"与"能动手"在启动日志上看起来一样 */
  record('desktop-inspect', flags.desktopInspectEnabled)
  record('desktop-operate', flags.desktopOperateEnabled)

  return (
    `kernel flags: ON=[${on.join(', ') || '无'}] OFF=[${off.join(', ') || '无'}] ` +
    `memory-window=${flags.memoryExtractionWindow} importance-threshold=${flags.memoryImportanceThreshold} ` +
    `action-sandbox=${flags.actionSandboxRoot} ` +
    // 第二批：恢复副本根也要可见 —— 否则"覆盖前留了副本吗、留在哪"无法从启动日志回答
    `local-file-recovery=${flags.localFileRecoveryRoot} ` +
    // 第二批：任务预算三件也要可见（"接了线但预算为 0 次"会看起来像"什么都没发生"）
    `task-budget=${flags.taskMaxActions}行动/${flags.taskMaxPlans}规划/${flags.taskDeadlineMs}ms ` +
    // WP1：决策期限也要可见 —— 否则"决策超时"会被读成"她不想用工具"
    `tool-decision=${flags.toolDecisionMode}/${flags.toolDecisionTimeoutMs}ms ` +
    // 第二批：浏览器 sidecar 地址（**不含凭证**）
    `browser-sidecar=${flags.browserSidecarUrl} ` +
    // M5.5：额度也要可见 —— 否则"开了搜索但额度是 0"会看起来像"什么都没发生"
    `web-search-evidence-tokens=${flags.webSearchEvidenceTokens} ` +
    // M6：摘要额度也要可见 —— 否则"接了线但额度是 0"会看起来像"什么都没发生"
    `rollup-tokens=${flags.rollupTokens} ` +
    // M7：关系接线是否真的在这条链上（"装了没有"必须一眼可见）
    `relationship-context=${flags.relationshipContextEnabled ? 'on' : 'off'} ` +
    // M8：情绪接线是否真的在这条链上（同上）
    `affect-context=${flags.affectContextEnabled ? 'on' : 'off'} ` +
    // M9：信念调度是否真的在这条链上（同上——"装了没有"必须一眼可见）
    `belief=${flags.beliefEnabled ? 'on' : 'off'} ` +
    // M9.1：重述复活发射是否真的在这条链上（同上；off 时重述诚实报 write_not_effective）
    `memory-restatement-revival=${flags.memoryRestatementRevivalEnabled ? 'on' : 'off'} ` +
    `withdrawn-context-masking=${flags.withdrawnContextMaskingEnabled ? 'on' : 'off'} ` +
    // M8.5：语义模式必须可见——否则"接线开着但模式是 rules"与"semantic"看起来一样
    `affect-semantic-mode=${flags.affectSemanticMode}`
  )
}
