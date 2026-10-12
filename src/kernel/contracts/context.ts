/**
 * ContextCompiler —— **唯一 Prompt 入口**。
 *
 * ============================================================================
 *  铁律 11：Context 必须经过 ContextCompiler
 * ============================================================================
 * 从现在开始不要直接拼字符串。任何模块都不允许：
 *
 *     systemPrompt += memory
 *     然后直接调模型
 *
 * 理由只有一个但足够：**以后必须知道"某轮回答究竟使用了哪些内容"**。
 * 若还在做字符串拼接，Trace 就无法表达"这一轮用了哪些记忆、哪个 Seed 版本、
 * 被裁掉了什么"，出问题时只能靠猜。
 *
 * 本文件是**纯组装**：它不知道 ElizaOS、不知道数据库、不读时间（时间由调用方注入）。
 * 具体的 content 由基础设施层的 provider 适配器提供，再进来排序、裁剪、量化。
 */

import { KernelError, type CharacterId, type ConversationEventId, type ConversationId, type Timestamp } from './ids.ts'
import { deriveCurrentInput, type Observation } from './observation.ts'

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/**
 * Section 种类（受控枚举）。
 *
 * M2.5 只有前三种；后面几种是**预留**，列在这里是为了让 `priority` /
 * 预算策略从一开始就有全局一致的约定，避免 M4 临时发明第二套排序规则。
 */
export type ContextSectionKind =
  /**
   * M3 起的身份核心 section（`identity-core`）。
   *
   * 与 `seed-identity` 同源（都是 `renderSeedIdentity` 的输出），
   * 分开两个 kind 是因为它们回答的问题不同：
   *   · `seed-identity` —— M2.5 的"人设锚点"
   *   · `identity`      —— M3 的"**这一轮用的是哪版人格**"，带版本与指纹引用
   */
  | 'identity'
  | 'seed-identity' // 不变的人设锚点，永不被裁（M2.5 的 id，v1 仍在使用）
  | 'recent-conversation' // 最近对话
  | 'current-input' // 本轮输入，永不被裁
  | 'critical-state' // 当前状态的语义摘要
  /**
   * M5.5.1 WP6：**此刻的挂钟时间**（年月日 + 星期 + 钟点）。
   *
   * 为什么它必须是一个**单独的 kind**，而不是塞进 `critical-state`：
   * `critical-state` 装的是"她此刻的内部状态"（情绪/关系），措辞里明确要求
   * "不要向对方复述这些数值"；而时间是**外部事实**，恰恰是**必须能照实说出口**的
   * 那类内容。两者的"能不能复述"规则相反，混成一段会让模型不知道该听哪条。
   */
  | 'clock'
  | 'memory' // M4
  /**
   * M5.5：**这一轮从网上查到的内容**（外部证据数据块）。
   *
   * 与 `memory` 分开是刻意的：记忆是"她自己知道的"，外部证据是"外面刚告诉她的"，
   * 两者可采信程度不同，混成一段会让"这是她记得的还是刚搜的"在 prompt 里消失
   * （ADR-045 `D-1`/`D-8`）。
   */
  | 'external-evidence'
  /**
   * M6.1 WP4 / ADR-055 `D-55e`：**程序生成的记录状态行**。
   *
   * 为什么不复用 `memory`：`memory` 装的是**记忆内容**（她要参考的数据），
   * 而这一条是**关于我们记录了什么的程序事实**（"本轮没有可依据的记录"）。
   * 两者被裁掉的后果相反 —— 记忆被裁只是回复质量下降，而这条被裁
   * 恰恰发生在"最需要它"的场景；混成一个 kind 会让两者在 trace 上无法区分。
   */
  | 'record-status'
  | 'rollup' // M5
  | 'relationship' // M7
  | 'affect' // M8
  | 'belief' // M9
  | 'goals' // M10
  | 'adaptive-self' // M11
  /**
   * 后 Lv2 · S1（ADR-091 §3 / 计划 §5.3）：**她感知到的世界/故事观测**。
   *
   * ⚠️ 为什么必须是**独立的 kind**，而不是并进 `current-input`：
   * `current-input` 渲染的是"对方刚刚说"（`deriveCurrentInput()` 的产物，
   * 且它**刻意拒绝**非对话观测）。把世界观测塞进那一块，就等于让它
   * **伪装成用户消息** —— 而那正是 `observation.ts` 开头那段注释点名要阻止的污染链：
   * 一条"剧情里门开了"被记成 `user_message` 之后，来源类别、权威等级、
   * reply graph 全部跟着错，而且是 append-only，改不回来。
   *
   * ⚠️ 与 `external-evidence` 的分工：外部证据是"**外面**刚告诉她什么"（当轮、可裁、来自出站查询）；
   * 本 kind 是"**她所在的有限故事**里已提交并被她感知到的事"（有来源身份、有可见性）。
   */
  | 'world-observation'
  /**
   * 实用能力加装（`Utility-Skills-Execution-Plan-2026-10-04.md` §2）：
   * **这一轮她自己读到的正文 / 算出来的结果**。
   *
   * ⚠️ 为什么必须是独立 kind，而不是并进 `external-evidence`：
   *    外部证据是"外面刚告诉她的**短摘要**"（每条 ≤ 600 字符、来自出站搜索、带 `E<n>` 标签）；
   *    本 kind 是"用户**显式指定**的资源被真的读进来"或"本地程序算出来的数"
   *    —— 长度量级、来源权威、失败口吻全都不同。合成一段会让
   *    "这是我读到的原文还是别人转述的摘要"在 prompt 里消失。
   *
   * ⚠️ 与 `world-observation` 的分工：那是"她所在的故事里发生的事"，
   *    本 kind 是"她这一轮从文件 / 网页 / 计算里**取得的数据**"。
   */
  | 'turn-content'
  | 'instruction' // 系统指令
  /**
   * post-Lv2 / ADR-111 `S03`：**一次主动机会**把哪些依据摆出来了。
   *
   * ```text
   * 它回答的问题与别的 section 都不同：不是"她这一轮知道什么"，
   * 而是"这一次**系统机会**里，程序给了她哪几条可以引用的依据"。
   * ```
   * ⚠️ **追加**的成员（既有成员与顺序一字未动）。
   * ⚠️ 装配层用**可选渲染器**（与 `renderBelief` 同形）：**不传 ⇒ 0 个 section**
   *    ⇒ `evals/fixtures/m3.5/prompt-baseline.txt` **逐字节不变**。
   *    任何"不传就变成 0 section"的扩展点才不会动冻结的 prompt 基线（M7/M8/M9 的同一先例）。
   */
  | 'system_opportunity'

/** 优先级：数字越大越先被保留。约定 0..100 */
export const SECTION_PRIORITY = {
  /** 当前输入：没有它就没有对话 */
  currentInput: 100,
  /** Seed：人格锚点，SC-001 的基础 */
  seedIdentity: 90,
  /** 系统指令 */
  instruction: 80,
  /** 关键状态：影响语气，但缺了仍能回答 */
  criticalState: 60,
  /**
   * M5.5.1 WP6：**此刻的挂钟时间**（58，紧贴 `criticalState` 之下）。
   *
   * 定在 58 而不是跟着 40/45 那一档，理由是这一条被裁掉的后果与"少想起一条记忆"
   * 不是同一量级：预算裁剪是**从低往高**裁的，而它只排在状态之后 —— 也就是说，
   * 只有当这一轮真的被裁到只剩身份/规则/输入时，它才会消失。
   *
   * ⚠️ 它仍然**不是** `droppable: false`：真正的硬保留只有
   *    identity / integrity-rules / 当前输入（以及那两条"结果事实"）。
   *    把时间也钉成不可裁，等于在预算最紧的一轮里多挤 30 来个 token，
   *    而那点收益不值得破坏"M3.5 起留出的可裁空间"这条既有约定。
   */
  clock: 58,
  /** 关系/情绪/信念等（M7+） */
  relationship: 55,
  affect: 52,
  belief: 50,
  goals: 45,
  /**
   * post-Lv2 / ADR-111 `S03`：**系统机会的依据面**。
   *
   * 取 43（`goals` 45 之下、`memory` 40 之上）：它只在**系统机会**那一类轮次里出现，
   * 且它约束的是"这一次机会你只能从这些依据里挑" —— 比"她此刻知道什么"更专。
   */
  systemOpportunity: 43,
  adaptiveSelf: 44,
  /** 长期记忆（M4） */
  memory: 40,
  /**
   * M5.5：外部证据（45，**高于记忆的 40**）。
   *
   * 排序依据是"这一轮谁更需要它"：
   *   · 记忆是**机会性**的（她恰好在上一轮想起了什么）
   *   · 外部证据是**用户显式要求**的（"帮我搜一下 X"），
   *     而且它只在当轮存在 —— 被裁掉就等于这一轮的搜索白做了
   * 因此预算不够时**先裁记忆**。
   * 但它仍然是 `droppable: true`：真正的硬保留只有 identity / integrity / 当前输入。
   */
  externalEvidence: 45,
  /**
   * M6.1 WP4 / ADR-055 `D-55e`：**记录状态行**（41，紧贴记忆的 40 之上）。
   *
   * 排序理由：它比记忆内容更需要被模型看到（记忆是"参考"，它是"这一轮有没有依据"），
   * 因此排在记忆之前。但它**真正的预算保证不靠优先级** —— 它走自己的额度
   * （见 `ContextSection.budgetGroup`），因此**不会**与记忆抢共享预算。
   */
  recordStatus: 41,
  /**
   * M9.5 `M9.5-FMB-01` 修复第 1 层：**"本轮该槽位没有可采信依据"时的指令性约束**。
   *
   * 与 `recordStatus`（41）**是两件不同的事**：
   *   · `recordStatus` 是**状态描述**（"我们记录到了什么 / 长期记忆为空"）—— M6.1 已验收，**不动**；
   *   · 本 section 是**行为约束**（"不得给出具体取值；主体不明先澄清"）。
   *
   * ⚠️ 为什么另起一条而不改 `recordStatus`：后者是 M6.1 的已验收组件
   *    （`m6.1:component` 313/0 · `m6.1:measurement` 16/0），改它的文本会破坏那些门。
   * ⚠️ 排序理由：它是**指令**，比状态描述更需要被看到 ⇒ 排在 `recordStatus` 之前。
   * ⚠️ 与其它 provider 同一纪律：**调用方不传 ⇒ 产 0 个 section**（M3.5 逐字节基线不受影响）。
   */
  memoryNoEvidenceConstraint: 42,
  /** 对话压缩（M5）：最低，因为它是"可用上下文"的替代品而不是事实 */
  rollup: 20,
  /**
   * 后 Lv2 · S1：**她感知到的世界/故事观测**（59，紧贴 `clock` 的 58 之上）。
   *
   * 排序理由：它不是"她想起了什么"，而是"**此刻她的处境是什么**"——
   * 缺了它她会按普通闲聊回答，而用户其实在与她一起推进一段共同经历。
   * 因此它排在状态/关系/记忆之上，但仍**低于**身份、规则与当前输入。
   *
   * ⚠️ 它仍然是 `droppable: true`：真正的硬保留只有 identity / integrity / 当前输入。
   * ⚠️ 与前几条同一纪律：**不传 ⇒ 产 0 个 section**（M3.5 逐字节基线不受影响）。
   */
  worldObservation: 59,
  /**
   * 实用能力加装：**这一轮她自己读到的正文 / 算出的结果**（46，紧贴 `externalEvidence` 的 45 之上）。
   *
   * 排序理由：它与外部证据同属"用户显式要求、只在当轮存在"的一档，
   * 但**取得代价更高**（真的读了文件 / 网页 / 跑了计算），因此排在外部证据**之前**；
   * 两者都低于关系/状态一档（55+），因为"她这一轮读了什么"不该挤掉"她是谁、对方在问什么"。
   *
   * ⚠️ 它仍然是 `droppable: true`：真正的硬保留只有 identity / integrity / 当前输入。
   * ⚠️ 与前几条同一纪律：**不传 ⇒ 产 0 个 section**（M3.5 逐字节基线不受影响）。
   */
  turnContent: 46,
} as const

export interface ContextSection {
  /** 稳定 id，例如 `seed-identity`、`recent-conversation`、`memory:<id>` */
  id: string
  kind: ContextSectionKind
  /** 越大越重要；相同则按 id 字典序，保证**确定性** */
  priority: number
  content: string
  /** 这一段内容来自哪些对象（记忆 id、事件 id、投影版本……），进 Trace */
  sourceRefs?: string[]
  /** 估算 token 数（由注入的 quantifier 提供；缺失时为 undefined） */
  estimatedTokens?: number
  /** 是否允许在预算不足时被裁剪。false 表示"硬保留" */
  droppable?: boolean
  /**
   * **独立预算分组**（M6.1 WP4 / ADR-055 `D-55e` ③）。
   *
   * `'status'` = 程序生成的记录状态行：它的额度来自
   * `ContextCompileInput.statusTokenBudget`，**不从共享 tokenBudget 里扣**
   * ⇒ 它的存在**不会**把记忆挤出去（"它是新增内容，必须有自己的额度"）。
   *
   * ⚠️ 额度**未给定**时退回共享预算（与其它可裁 section 同一条规则）——
   *    于是"忘了给额度"表现为"它和普通 section 一样竞争"，而不是"永远保留"。
   */
  budgetGroup?: 'status'
}

/** token 量化器：领域层不做 tokenizer 依赖，由基础设施注入 */
export type TokenQuantifier = (text: string) => number

/** section 提供者：基础设施实现（provider 适配器、投影读取……） */
export interface ContextSectionProvider {
  readonly name: string
  /** 产出的 section（可能 0 个，例如"没有相关记忆"） */
  provide(input: ContextCompileInput): Promise<ContextSection[]>
}

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export interface ContextCompileInput {
  characterId: CharacterId
  /**
   * 本轮输入（用户消息）。
   *
   * ⚠️ M3.5 起它**不是独立来源**：当 `observation` 存在时，它必须等于
   * `deriveCurrentInput(observation)`（`characterTurnContextOf` 会校验）。
   * 保留这个字段是为了不破坏既有调用方与"合成轮次"（`--dump-prompt`），
   * 而**不是**为了允许两个来源长期并存 —— 两个来源就一定会有一天不一致，
   * 而"她看到的输入"与"事件里记的输入"不一致是最难查的一类缺陷。
   */
  currentInput: string

  /**
   * M3.5（计划书第 10 / 43 / 87 节）：本轮她**感知到了什么**。
   *
   * optional 是刻意的：
   *   · 合成轮次（`--dump-prompt` 的只读编译、既有回归脚本）根本没有事件，
   *     因此没有 Observation —— 那时**没有**比伪造一个更好
   *   · 世界事件（未来的 ENVIRONMENT_OBSERVATION）会带它进来，而那时
   *     它才是真正的输入来源
   */
  observation?: Observation

  /**
   * 本轮输入对应的事件（刚写入的 ConversationEvent）。
   * 有了它才能让 Trace 回答"这一轮的回答基于哪个事件"。
   */
  currentEventId?: ConversationEventId
  /** 本轮已经写进上下文的最近对话事件（基础设施按需查询后传入） */
  recentEvents?: readonly {
    id: ConversationEventId
    sequence: number
    speaker: string
    text: string
  }[]
  /** 预算（token）。不传 = 不裁剪 */
  tokenBudget?: number
  /**
   * M6.1 WP4 / ADR-055 `D-55e` ③：**记录状态行自己的额度**。
   *
   * 它与 `tokenBudget` **分开记账**：状态行的 token **不从**共享预算里扣，
   * 因此"多了一行状态"不会把记忆 section 挤掉。不传 = 状态行退回共享预算。
   */
  statusTokenBudget?: number
  /** 由调用方注入的时间，保证编译器本身可测、可重放 */
  now: Timestamp
}

export interface ContextPacket {
  /** Explicit images bound to this compiled user turn; never rendered into prompt text or logs. */
  images?: readonly import('./image-input.ts').ImageInput[]
  characterId: CharacterId
  compilerVersion: string

  /** 已排序、已裁剪的 section（顺序即最终拼装顺序） */
  sections: ContextSection[]

  /** 最终拼装文本（唯一允许交给模型的东西） */
  text: string

  /** 引用了哪些对话事件 */
  sourceConversationEventIds: string[]

  /**
   * 被预算裁掉的 section id。
   *
   * 这一个字段是"可解释性"的关键：以后回答"她当时是不是忘了某事"，
   * 看这里就知道是被裁了、还是根本没召回。
   */
  droppedSectionIds: string[]

  estimatedTokens: number
  generatedAt: Timestamp

  /**
   * **每个 provider 的耗时**（毫秒；可选读数，`P4` 后的时延修复用）。
   *
   * ============================================================================
   *  为什么它必须从编译器里出来
   * ============================================================================
   * 实测：一轮 23.684 s 的生成里，`compileTurn`（providers → prompt）占 **20.146 s = 85%**，
   * 而模型调用只有 2.453 s。可"装配慢"仍然是个黑盒 —— providers 是**顺序**跑的
   * （见 `compile()` 的 `for...of`），总耗时是它们之和，所以必须**按 provider 分开量**，
   * 否则"该优化哪一个"只能猜。
   *
   * ⚠️ 它**只是读数**：不参与预算、不进 prompt、不影响任何判据（`sections` / `text`
   *    与加它之前逐字节相同）。缺失 ⇒ `undefined`（旧调用点不受影响）。
   */
  providerTimingsMs?: Record<string, number>
}

export const CONTEXT_COMPILER_VERSION = 'context-compiler@1' as const

// ---------------------------------------------------------------------------
// CharacterTurnContext（M3.5：计划书第 87 / 88 节）
// ---------------------------------------------------------------------------

/**
 * 一轮编译的输入上下文。
 *
 * 计划书第 87 节要求把编译入口从"一个 message 字符串"升级成
 * `CharacterTurnContext`：
 *
 * ```text
 * ConversationEvent
 *       ↓
 * ConversationObservation
 *       ↓
 * CharacterTurnContext        ← 这里
 *       ↓
 * ContextCompiler
 * ```
 *
 * ⚠️ `currentInput` 仍然在这个结构里，但它现在是**派生结果**而不是输入参数：
 * 它由 `observation` 算出来，因此不存在"两个来源互相矛盾"的可能。
 * 保留字段名是为了让既有 section provider（`createCurrentInputProvider`）
 * 一行都不用改 —— 于是 prompt 的渲染结果与 M3 逐字节相同（FC-T08）。
 */
export interface CharacterTurnContext {
  characterId: CharacterId
  /** 她这一轮感知到了什么。合成轮次没有（见 `ContextCompileInput.observation`） */
  observation?: Observation
  /** 本轮所属会话（可替换，计划书第 8 节） */
  conversationId?: ConversationId
  /**
   * 本轮输入文本。
   *
   * ⚠️ 它**可能不存在**，而且这是一个有意义的状态，不是"忘了填"：
   * 非对话观测（未来的 `ENVIRONMENT_OBSERVATION` 等）**没有**"当前输入文本"
   * 这个概念 —— 把"房间的灯熄灭了"渲染成"对方刚刚说：灯熄灭了"，
   * 正是 Observation 这一层要阻止的那种伪装（计划书第 13 / 76 节）。
   *
   * M3.5 的职责到"边界能接收它"为止：计划书第 76 节写的是
   * 「确认 Character API 可以接收。但不要求模型实际处理」。
   * 把世界观测**真正渲染进 prompt** 需要一个新的 section 种类，
   * 而那属于后续阶段（第 43 节明确 M3.5 不增加 section）。
   */
  currentInput?: string
}

export interface CharacterTurnContextInput {
  characterId: CharacterId
  observation?: Observation
  conversationId?: ConversationId
  /** 显式传入的输入文本（合成轮次用；有对话观测时作为一致性校验的对照） */
  currentInput?: string
}

/**
 * 构造一轮的上下文（**唯一**入口，派生与校验都在这里）。
 *
 * 四条规则，按 observation 的种类分：
 *
 *   1. **没有** observation → 必须给 `currentInput`（合成轮次：`--dump-prompt`、
 *      既有回归脚本）。这与 M3 完全一致。
 *   2. **对话**观测 → 文本由 `deriveCurrentInput(observation)` 派生；
 *      同时又显式传了 `currentInput` 就必须一致，否则
 *      `observation_input_mismatch`（失败关闭）。这是 M3.5 的关键：
 *      它让"显式传文本"这条旧路径**无法**与新的 Observation 路径悄悄分叉。
 *   3. **非对话**观测 → 不派生、也不接受显式文本：
 *      给了 `currentInput` 就抛 `observation_not_renderable_as_input`。
 *      于是"把世界事件伪装成用户消息"在类型上走不通、在运行期也走不通。
 *   4. 两者都没有 → `turn_without_input`。
 */
export function characterTurnContextOf(input: CharacterTurnContextInput): CharacterTurnContext {
  const explicit = input.currentInput

  // --- 规则 1：合成轮次 -----------------------------------------------------
  if (input.observation === undefined) {
    if (explicit === undefined || explicit.trim() === '') {
      throw new KernelError(
        'validation_error',
        'turn_without_input',
        '一轮编译必须有输入：要么给 observation，要么给 currentInput'
      )
    }
    return {
      characterId: input.characterId,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      currentInput: explicit,
    }
  }

  // --- 规则 3：非对话观测（失败关闭：不许伪装）-----------------------------
  if (!isRenderableAsInput(input.observation)) {
    if (explicit !== undefined) {
      throw new KernelError(
        'validation_error',
        'observation_not_renderable_as_input',
        `${input.observation.type} 没有"当前输入文本"：把世界事件当成用户说的一句话，` +
          '正是 Observation 要阻止的伪装（计划书第 13 / 76 节）',
        { type: input.observation.type }
      )
    }
    return {
      characterId: input.characterId,
      observation: input.observation,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    }
  }

  // --- 规则 2：对话观测 -----------------------------------------------------
  const derived = deriveCurrentInput(input.observation)
  if (explicit !== undefined && explicit !== derived) {
    throw new KernelError(
      'validation_error',
      'observation_input_mismatch',
      '显式输入与该轮 Observation 派生出的文本不一致：' +
        '两个来源必然有一天会分叉，因此这里失败关闭而不是"取其中一个为准"',
      { derived, explicit }
    )
  }

  return {
    characterId: input.characterId,
    observation: input.observation,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    currentInput: derived,
  }
}

/**
 * 这个观测有没有"当前输入文本"这个概念。
 *
 * 目前只有对话观测有（计划书第 11 节：M3.5 真正实现的只有这一种）。
 * 其余种类登记在枚举里，因此**能**被构造、能被 API 接收，
 * 但还不能被渲染成"她刚刚听到的那句话"。
 */
export function isRenderableAsInput(observation: Observation): boolean {
  return observation.type === 'CONVERSATION_OBSERVATION'
}

export interface ContextCompiler {
  readonly version: string
  /** 每次编译都必须产出 packet；不允许"这次不编译"这种旁路 */
  compile(input: ContextCompileInput): Promise<ContextPacket>
}

// ---------------------------------------------------------------------------
// 确定性组装实现
// ---------------------------------------------------------------------------

export interface DeterministicContextCompilerOptions {
  version?: string
  providers: readonly ContextSectionProvider[]
  /** 无量化器时不做裁剪，estimatedTokens 用字符数近似 */
  quantifier?: TokenQuantifier
}

/**
 * 确定性 ContextCompiler。
 *
 * "确定性"是刻意的：同样的 (providers 输出, 输入, 预算) 必须产出**逐字节相同**的
 * packet.text 与相同的 droppedSectionIds。这样 Trace 可复现、SC-006 可判定、
 * 也能对"上下文组装"单独写回归测试而不必调模型。
 */
export function createContextCompiler(
  options: DeterministicContextCompilerOptions
): ContextCompiler {
  const version = options.version ?? CONTEXT_COMPILER_VERSION
  const quantifier = options.quantifier ?? ((text: string) => Math.ceil(text.length / 2))

  return {
    version,
    async compile(input: ContextCompileInput): Promise<ContextPacket> {
      const collected: ContextSection[] = []
      /*
       * `P4` 后的时延修复：providers 是**顺序**跑的，所以总耗时是它们之和 ——
       * 按 provider 分别量，才能指出"是谁吃掉了那 20 秒"。
       * ⚠️ 纯读数：不改顺序、不改输出（`sections` / `text` 逐字节不变）。
       */
      const providerTimingsMs: Record<string, number> = {}

      for (const provider of options.providers) {
        const providerStarted = Date.now()
        const sections = await provider.provide(input)
        providerTimingsMs[provider.name] =
          (providerTimingsMs[provider.name] ?? 0) + (Date.now() - providerStarted)
        for (const section of sections) {
          if (section.content.trim() === '') continue
          collected.push({
            ...section,
            estimatedTokens: section.estimatedTokens ?? quantifier(section.content),
          })
        }
      }

      const deduped = dedupeById(collected)
      const sorted = sortSections(deduped)

      const { kept, dropped } = applyBudget(sorted, input.tokenBudget, input.statusTokenBudget)

      const text = renderPacketText(kept)
      const estimatedTokens = kept.reduce((sum, s) => sum + (s.estimatedTokens ?? 0), 0)

      return {
        characterId: input.characterId,
        compilerVersion: version,
        sections: kept,
        text,
        sourceConversationEventIds: collectSourceRefs(kept),
        droppedSectionIds: dropped.map((s) => s.id).sort(),
        estimatedTokens,
        generatedAt: input.now,
        providerTimingsMs,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 内部纯函数
// ---------------------------------------------------------------------------

/**
 * 同 id 的 section 只保留第一个（提供者顺序即优先级顺序）。
 *
 * 竞争同一个 id 说明两个模块都想提供"seed-identity"这种东西，
 * 属于配置错误；保留先注册者 + 丢弃后来者，比抛错更适合运行期，
 * 但会在 packet 里体现为 dropped。
 */
function dedupeById(sections: readonly ContextSection[]): ContextSection[] {
  const seen = new Map<string, ContextSection>()
  for (const section of sections) {
    if (!seen.has(section.id)) seen.set(section.id, section)
  }
  return [...seen.values()]
}

/**
 * 排序规则：priority 降序，priority 相同按 id 升序。
 *
 * 第二关键字必须是确定的（不能用插入顺序），否则不同 provider 完成顺序
 * 会改变最终 prompt——那会让 Trace 失去复现能力。
 */
export function sortSections(sections: readonly ContextSection[]): ContextSection[] {
  return [...sections].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * 预算裁剪。
 *
 * 规则：
 *   1. 按排序结果依次装入，能装下就装。
 *   2. `droppable === false` 的 section **无条件保留**（Seed 与当前输入），
 *      即使超预算——宁可超，也不能让"她忘了自己是谁"或"忘了用户在问什么"。
 *   3. 其余装不下的进 dropped。
 *
 * 不传 tokenBudget 时不做裁剪。
 */
function applyBudget(
  sections: readonly ContextSection[],
  tokenBudget: number | undefined,
  statusTokenBudget?: number
): { kept: ContextSection[]; dropped: ContextSection[] } {
  if (tokenBudget === undefined) return { kept: [...sections], dropped: [] }
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new KernelError(
      'validation_error',
      'bad_token_budget',
      `tokenBudget 必须是正数，收到 ${String(tokenBudget)}`
    )
  }
  if (
    statusTokenBudget !== undefined &&
    (!Number.isFinite(statusTokenBudget) || statusTokenBudget <= 0)
  ) {
    /*
     * 一个 0 或负的"状态行额度"会静默变成"这一轮没有状态行"——
     * 而"没有状态行"恰恰是最需要它的那种情形的反面。因此这里失败关闭，
     * 与 `tokenBudget` 同一条纪律。
     */
    throw new KernelError(
      'validation_error',
      'bad_status_token_budget',
      `statusTokenBudget 必须是正数，收到 ${String(statusTokenBudget)}`
    )
  }

  const kept: ContextSection[] = []
  const dropped: ContextSection[] = []
  let used = 0
  /** M6.1 WP4：状态行自己的账（**不并入 `used`**，见 `ContextSection.budgetGroup`） */
  let statusUsed = 0

  for (const section of sections) {
    const cost = section.estimatedTokens ?? 0
    if (section.droppable === false) {
      kept.push(section)
      used += cost
      continue
    }

    /*
     * M6.1 WP4 / ADR-055 `D-55e` ③：**独立额度的 section**。
     *
     * 它从 `statusTokenBudget` 里扣，**不计入** `used` ⇒ 多出这一行
     * 不会减少留给记忆的额度（那正是"不得挤占记忆"的机器形态）。
     * 额度未给定时**不**进这个分支 ⇒ 退回下面的共享预算（与其它可裁 section 同）。
     */
    if (section.budgetGroup === 'status' && statusTokenBudget !== undefined) {
      if (statusUsed + cost <= statusTokenBudget) {
        kept.push(section)
        statusUsed += cost
      } else {
        dropped.push(section)
      }
      continue
    }

    if (used + cost <= tokenBudget) {
      kept.push(section)
      used += cost
    } else {
      dropped.push(section)
    }
  }

  // 保持"返回顺序 = 最终拼装顺序"：kept 已经按排序结果推进，无需再排。
  return { kept, dropped }
}

function renderPacketText(sections: readonly ContextSection[]): string {
  return sections.map((s) => s.content.trimEnd()).join('\n\n')
}

function collectSourceRefs(sections: readonly ContextSection[]): string[] {
  const refs = new Set<string>()
  for (const section of sections) {
    for (const ref of section.sourceRefs ?? []) refs.add(ref)
  }
  return [...refs].sort()
}
