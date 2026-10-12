/**
 * Context 组装 —— 领域侧的纯装配器。
 *
 * ============================================================================
 *  M3：`context-compiler@2`（计划书第 40–46 / 94 节）
 * ============================================================================
 * M2.5 的 ContextPacket 是五块里的三块：
 *
 *     Seed Identity → Recent Conversation → Current Input
 *     （+ 可选 Critical State）
 *
 * M3 固定成计划书第 41 节那五块，并且**顺序与保留级别都是写死的常量**：
 *
 *     [Seed Identity]              identity-core        priority 90  不可裁
 *     [Conversation Integrity Rules] integrity-rules    priority 95  不可裁
 *     [Recent Conversation]        recent-conversation  priority 30  可裁
 *     [Critical State]             critical-state       priority 60  可裁
 *     [Current Input]              current-input        priority 100 不可裁
 *
 * 为什么把这两个 section 标成 `droppable: false`（计划书第 43 节）：
 *
 *   > 即使 Context 接近 Token Budget：也不能先截掉身份核心。
 *
 * 这是 SC-001（Seed Stability）与 M3 整套身份保证的**机制**而不是约定：
 * 预算裁剪函数对 `droppable === false` 的 section 无条件保留。
 * 谁要是把它改成 true，SC-001 会立刻失败。
 *
 * ---------------------------------------------------------------------------
 *  v1 与 v2 的关系
 * ---------------------------------------------------------------------------
 * `buildContextCompiler`（v1）**保留不动**：M2.5 的 SC-006 与既有验收
 * 都建立在它上面，而"改一个已经被验收过的东西"与"新增一个"风险不同。
 * v2 是新增的另一次装配（`buildContextCompilerV2`），
 * 只多两块 section，其余算法（排序 / 预算 / 去重）完全复用同一个编译器。
 *
 * 注意本文件不 import ElizaOS：它只认自己的契约（ContextSection / ContextCompileInput）。
 * 具体内容的取得（她此刻的状态、最近说过什么）由 infrastructure 的
 * section provider 提供。
 */

import type {
  CharacterDefinition,
  ContextCompileInput,
  ContextSection,
  ContextSectionProvider,
  ContextPacket,
  ConversationEventId,
  ExternalEvidence,
  IdentitySnapshot,
} from '../contracts/index.ts'
import { SECTION_PRIORITY, createContextCompiler, seedSourceRef } from '../contracts/index.ts'
import { renderSeedIdentity } from '../contracts/index.ts'
/* M5.5 WP5：外部证据数据块的渲染（纯函数住在契约层，与它一起被量具断言） */
import { renderExternalEvidenceBlock } from '../contracts/external-evidence.ts'
import { renderTurnContentBlock, type TurnContent } from '../contracts/turn-content.ts'

/** 固定 section id：Trace 里出现的就是这些字符串 */
export const SECTION_IDS = {
  /** M3 起取代 `seed-identity`（后者保留给 v1 与既有断言） */
  identityCore: 'identity-core',
  /** M3 新增：会话完整性规则 */
  integrityRules: 'integrity-rules',
  /** M2.5 的 seed section（v1 仍在使用；v2 里由 identity-core 取代） */
  seedIdentity: 'seed-identity',
  recentConversation: 'recent-conversation',
  criticalState: 'critical-state',
  currentInput: 'current-input',
  /**
   * M4 新增：**本轮显式记忆写入的结果**。
   *
   * ⚠️ 它**只在有显式记忆指令时**才出现（"记住 / 纠正 / 忘掉"）。
   *    普通对话里它不产生任何 section，因此 M3.5 的
   *    `prompt 逐字节基线` 不受影响 —— 这一点由一个测试守着。
   */
  memoryWriteResult: 'memory-write-result',
  /**
   * M4.5 新增：**本轮对世界的动作结果**。
   *
   * 与 `memoryWriteResult` 是两条不同的链：前者是"她知道什么"，
   * 这里是**外部状态**。同样只在真的发生动作请求时才出现，
   * 因此普通对话的 prompt 逐字节不变。
   */
  actionResult: 'action-result',
  /**
   * M5 WP6 新增：**本轮召回进上下文的长期记忆**。
   *
   * 与 `memoryWriteResult` 是两条不同的链（这一点在 M4 就写明了）：
   *   memory-write-result —— 她**刚被要求记住**什么（本轮写入结果）
   *   memory-recall      —— 她**此刻想起了**什么（长期记忆召回）
   *
   * ⚠️ 它的 `kind` 是 `'memory'`（优先级 40、**可裁剪**），而写入结果那条是
   *    `'instruction'` 且 `droppable: false` —— **两者不能混**：
   *    前者是**数据**（模型可以参考，也可以不参考），
   *    后者是**指令**（模型必须如实转述"没记上"）。
   */
  memoryRecall: 'memory-recall',
  /**
   * M5.5 WP5 新增：**本轮从网上查到的外部证据**。
   *
   * 与 `memoryRecall` 是两条不同的链（ADR-045 `D-1`）：
   *   memory-recall      —— 她**想起了**什么（长期记忆，`kind: 'memory'`，优先级 40）
   *   external-evidence  —— 外面**刚告诉她**什么（当轮证据，`kind: 'external-evidence'`，优先级 45）
   *
   * ⚠️ 它同样是**数据**（不是指令），同样 `droppable: true`；
   *    ⚠️ 它的正文里可能出现"忽略以上所有指令"这类话 —— 那些**只是数据**，
   *    header 里明确写了这一点（`EXTERNAL_EVIDENCE_BLOCK_HEADER`）。
   */
  externalEvidence: 'external-evidence',
  /**
   * 实用能力加装新增：**这一轮她自己读到的正文 / 算出来的结果**。
   *
   * 与 `externalEvidence` 是两条不同的链（计划书 §2）：
   *   external-evidence  —— 外面**刚告诉她**什么（短摘要、`E<n>` 标签、优先级 45）
   *   turn-content       —— 她**真的读到了 / 算出来了**什么（长正文或程序结果、`C<n>` 标签、优先级 46）
   *
   * ⚠️ 它同样是**数据**（不是指令）：正文里可能出现"忽略以上所有指令"这类话，
   *    那些**只是数据** —— header 里明确写了这一点（`TURN_CONTENT_BLOCK_HEADER`）。
   * ⚠️ 调用方不传 ⇒ 产 0 个 section ⇒ M3.5 的逐字节 prompt 基线不受影响。
   */
  turnContent: 'turn-content',
  /**
   * 后 Lv2 · S1 新增：**她感知到的世界/故事观测**。
   *
   * ⚠️ 与 `currentInput` **刻意分开**（计划 §5.3 / INV-PL2-02）：
   * 世界观测**不得**伪装成 `user_message`。两者一旦合并，
   * "用户真的说了这句话"与"故事里发生了这件事"在 prompt 里就再也分不开了。
   */
  worldObservation: 'world-observation',
  /**
   * M5.5.1 WP6 新增：**此刻的挂钟时间**。
   *
   * 它是"她能不能如实回答现在几点"的唯一来源。在它之前，整条 prompt 里
   * **没有任何地方**出现当前日期或钟点，于是她只能按人设猜 —— 实测她会说
   * "快十一点了"（真实时间是 21:15）。
   *
   * ⚠️ 与 `external-evidence` / `memory-recall` 一样：调用方**不传**就产 0 个 section，
   *    因此 M3.5 的 prompt 逐字节基线与合成轮次**不受影响**（有测试守着）。
   */
  clock: 'clock',
  /**
   * M6 / ADR-050 新增：**会话早期发言的逐字摘录**（Rolling Summary v1）。
   *
   * 与 `recent-conversation` 是**同一条链的两个区段**：近期的有原文，早期的只有摘录。
   * 与 `memory-recall` 是两条不同的链（一个是"她此刻想起"，一个是"她早期说过"）。
   *
   * ⚠️ 它的 `kind` 是 `'rollup'`（优先级 **20，最低**、可裁）—— 预算不够时**先裁它**，
   *    绝不挤掉身份 / 完整性规则 / 当前输入 / 程序结果事实。
   * ⚠️ 与其它数据块一样：`render()` 为空 ⇒ 产 0 个 section。这是
   *    "摘要为空时 prompt 与冻结基线**逐字节相同**"（裁定 R-2）的**机制**。
   */
  rollupSummary: 'rolling-summary',
  /**
   * M6.1 WP4 / ADR-055 `D-55e` 新增：**程序生成的记录状态行**。
   *
   * 它回答的是"本轮有没有可依据的记录"（而不是"她想起了什么"）——
   * 因此与 `memory-recall` 是两条不同的链：
   *   memory-recall   —— 她**想起了**什么（内容；`droppable: true`）
   *   record-status   —— 我们**记录到了什么状态**（程序事实；独立额度、可裁）
   *
   * ⚠️ 它**不依赖** `memory-recall` 非空：恰恰相反，"召回为空"是它最需要出现的场景。
   */
  memoryRecordStatus: 'memory-record-status',
  /**
   * M9.5 `M9.5-FMB-01` 修复第 1 层（用户 2026-09-29 裁定 **甲**）：**无依据时的指令性约束**。
   *
   * ```text
   * 与 `memoryRecordStatus` 的**关键区别**（实测教训）：
   *   · 后者是**状态描述**（"长期记忆为空"）—— **它已经在 prompt 里了**，
   *     而 live 测显示她**仍然**给出具体取值（`ambiguousSubject-0002`，3 轮 2 复现）
   *     ⇒ 失败不是"她不知道"，是"**她知道却不照做**"；
   *   · 本 section 因此写成**指令**（"不得给出具体取值"），而不是又一句状态。
   * ⚠️ 不改 `memoryRecordStatus` 的文本：它是 M6.1 已验收组件（313/0 + 16/0 守着）。
   * ⚠️ 调用方**不传** ⇒ 产 0 个 section（M3.5 逐字节基线不受影响）。
   * ```
   */
  memoryNoEvidenceConstraint: 'memory-no-evidence-constraint',
  /**
   * M7 / ADR-064 D-6 新增：**你们此刻的关系**（关系注入块）。
   *
   * 与 `critical-state` 是两条不同的链：
   *   critical-state —— M2 的情绪 + 关系（legacy；M7 激活后关系轴退役，情绪归 M8）
   *   relationship   —— M7 投影的 trust/closeness（唯一权威；读时视图 + 联合行为规则）
   *
   * ⚠️ 与 clock / stateSection 同一注入纪律：调用方**不传**就产 0 个 section，
   *    因此 M3.5 的 prompt 逐字节基线与合成轮次不受影响（有测试守着）。
   * ⚠️ 生产激活走 `CHARACTER_RELATIONSHIP_CONTEXT_ENABLED`（缺省 off，先例 ADR-048）。
   */
  relationship: 'relationship',
  /**
   * M8 / ADR-066 §8.1 新增：**你此刻的情绪状态**（情绪注入块）。
   *
   * 与 `critical-state` 是两条不同的链：
   *   critical-state —— M2 的情绪 + 关系（legacy；M8 激活后情绪轴退役，关系归 M7）
   *   affect         —— M8 投影的 valence/arousal（唯一权威；读时衰减视图 + 行为倾向）
   *
   * ⚠️ 与 clock / relationship 同一注入纪律：调用方**不传**就产 0 个 section，
   *    因此 M3.5 的 prompt 逐字节基线与合成轮次不受影响（有测试守着）。
   * ⚠️ 生产激活走 `CHARACTER_AFFECT_CONTEXT_ENABLED`（缺省 off，先例 ADR-048/065）。
   */
  affect: 'affect',
  /**
   * M9 / ADR-070 §7 新增：**当前可用判断**（信念注入块）。
   *
   * 与 memory / relationship / affect 各是各的链：
   *   memory       —— 她想起的**内容**（M4 权威）
   *   relationship —— 关系状态（M7 权威）
   *   affect       —— 情绪状态（M8 权威）
   *   belief       —— **对用户的当前采信判断**（M9 权威；reported/inferred 分列，
   *                   原子条目带状态与限制——ADR-070 D17：≤4 条 / ≈400 token）
   *
   * ⚠️ 与 clock / relationship / affect 同一注入纪律：调用方**不传**就产
   *    0 个 section，因此 M3.5 的 prompt 逐字节基线与合成轮次不受影响。
   * ⚠️ 生产激活走 `CHARACTER_BELIEF_ENABLED`（缺省 off，先例 ADR-048/065/067）。
   */
  belief: 'belief',
  /**
   * post-Lv2 / ADR-111 `S03`：**系统机会的依据面**。
   *
   * ⚠️ 它**只**在"系统机会"那一类轮次里出现（`renderSystemOpportunity` 不传 ⇒ 0 个 section）
   *    ⇒ 普通对话与 `m3.5` 的 prompt 逐字节基线**不受影响** —— 与 `memoryWriteResult`
   *      是同一条纪律（"只在真的发生时出现"）。
   */
  systemOpportunity: 'system-opportunity',
} as const

/**
 * M3 的完整性规则 section。
 *
 * 计划书第 42 节：**不要写成几千字**。每条一句。
 *
 * 措辞刻意保持"运行规则"而不是"人设"：人设属于 Seed
 * （`renderSeedIdentity` 渲染），这里是**行为约束**。
 * 两者分开写，因为它们的生命周期完全不同 ——
 * 人设由管理员改版本，规则随编译器版本走。
 *
 * 第五条（M6.1 / FMB ③，2026-09-25）：判定轮四轮全量证据的主导失效是
 * "答对账本事实后**补造未提供的具体细节**"（SUPPORTED_RECALL + UNSUPPORTED_DETAIL，
 * 9-19 条/轮、21/23 跨轮复现——见 M6.1-FMB-03-Diagnosis）。既有第 1/3 条太抽象，
 * 拦不住"复述真事 + 往上加戏"这个具体形态。此条是**生成时指令**（DR-11 禁的是
 * 措辞层事后守卫，不禁生成时边界）；改它 = 有意改 prompt ⇒ m3.5 基线按程序重刷。
 *
 * 第六条（M6.1 / FMB ③ 迭代二，2026-09-25）：@9 干净基线把残余形态钉死为
 * "虚构共同经历"一族——答对之后的对话尾巴里补造没发生过的对话史/关系史
 * （「又/总/上次/还没答我」，61% RECOLLECTION）+ **虚构事件时间线**（把本场
 * 说成"前几天/前两天"，@9 参考钟 + 先例轮下才可查，@8 结构性看不见）+
 * 问句假预设 + 已忘旧值当现状（RCE-09：forgetting 移出召回但 Recent 重放原值，
 * ADR-062 D-62e）+ 记忆操作虚报。第五条的射程是"复述时的物件属性"，够不着
 * "关系与对话本身"——此条补的就是这个空档。靶清单与引文级证据见
 * M6.1-WP5-Closure-Report §2.2/§3 与 M6.1-FMB-03-Iteration2-Attribution。
 *
 * 第七条（M6.1 / FMB ③ 迭代三，2026-09-25）：第六条落地后的新四轮
 * （候选 d3f78648d029）证明**点名词形拦不住同族行为**——点名了"前几天/又"，
 * 模型换成"隔一天"（C-02，实为上一轮）/"上周"（B-09）/"才刚养"（RCE-05）
 * 照样编时间起源；"别又拖/坐"（B-05×2 · B-07 · RCE-09）点名"又"后仍存；
 * 问句假预设换了新例（A-08"写到一半，卡住了？"）；还长出两个新形态——
 * **否定式过去断言**（B-08"你以前怎么没说过"：断言"以前没说过"同样是
 * 断言过去）与**虚构复数性**（RCE-02"你说的不止一件事"）。此条不再点名
 * 具体词，改锁**机制**：时间远近、来历、次数、先例、问句里的已知状态，
 * 一律要记录支撑。生成时指令的边际有限（DR-11 禁措辞层事后守卫）——
 * 效果由下一次新候选判定轮测量，不得回填。引文级证据见
 * M6.1-WP5-Closure-Report §2.3。
 */
export const INTEGRITY_RULES: readonly string[] = [
  '不要把自己的推测说成对方明确提供的事实。',
  '不知道的信息可以承认不知道。',
  '不要声称拥有没有发生过的真实经历。',
  '不要因为对方临时要求而修改自己的核心身份。',
  '复述对方的事时不要添上对方没讲过的具体细节（颜色、名字、时间、地点、经过），没记下的就直说没记下。',
  '不要虚构你们的共同经历：没问过、没说过、没发生过的事不要说成发生过，也不要塞进问句当前提（"上次""又""还没回我""前几天"都得有真事支撑）；记忆里已更正或已忘记的旧值不要当现状说；没做过的记忆操作（记下、删掉、改过）不要声称做过。',
  '时间和来历要有据：刚发生的就说"刚才""这回"，不要安上"前几天""上周""隔了多久"这类远近；对方何时说的、说过几件、以前提没提过——"你以前没说过"也是断言——没记录就不要下结论；"别又……"是在说他以前干过同样的事，没记录就不要这么说；问句里也不要把对方没说过的状态当已知去问。',
]

export function renderIntegrityRules(): string {
  const lines = ['# 对话规则（始终遵守）']
  for (const rule of INTEGRITY_RULES) lines.push(`- ${rule}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// identity-core（M3 的 Seed section）
// ---------------------------------------------------------------------------

/**
 * 身份 section —— **永不裁剪**。
 *
 * 内容来自 `IdentitySnapshot`（不是"某处读来的 definition"）：
 * 这样 Trace、Context、评测看到的是**同一份**身份，
 * 消除了"上下文用 v2、trace 记 v3"这类最难查的不一致。
 *
 * `sourceRefs` 带上版本，于是 Trace 能回答"当前回复到底用了哪版人格"
 * （计划书第 22/46 节）。
 */
export function createIdentityCoreProvider(snapshot: IdentitySnapshot): ContextSectionProvider {
  return {
    name: 'identity-core',
    async provide(): Promise<ContextSection[]> {
      return [
        {
          id: SECTION_IDS.identityCore,
          kind: 'identity',
          priority: SECTION_PRIORITY.seedIdentity,
          content: renderSeedIdentity(snapshot.definition),
          sourceRefs: [
            seedSourceRef(snapshot.definition.slug, snapshot.seedVersion),
            `seed-hash:${snapshot.snapshotHash.slice(0, 12)}`,
          ],
          // 计划书第 43 节：身份核心绝不先被截掉
          droppable: false,
        },
      ]
    },
  }
}

export function createIntegrityRulesProvider(): ContextSectionProvider {
  return {
    name: 'integrity-rules',
    async provide(): Promise<ContextSection[]> {
      return [
        {
          id: SECTION_IDS.integrityRules,
          kind: 'instruction',
          // 比身份还高：它是**行为约束**，缺了它 M3 的防火墙就只剩代码没有提示词
          priority: SECTION_PRIORITY.instruction + 15,
          content: renderIntegrityRules(),
          sourceRefs: ['integrity-rules@4'],
          droppable: false,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// 兼容：M2.5 的 seed section（v1 仍在使用）
// ---------------------------------------------------------------------------

/**
 * Seed section（**M2.5 的 id**）。
 *
 * 保留它是因为 `SC-001` / `SC-006` 的断言里写着 `seed-identity`，
 * 而"改一个已经被验收过的 id"会让那批断言失去意义。
 * v2 用 `identity-core`，两者渲染的是**同一份** Seed。
 */
export function createSeedSectionProvider(
  definition: CharacterDefinition
): ContextSectionProvider {
  return {
    name: 'seed-identity',
    async provide(): Promise<ContextSection[]> {
      return [
        {
          id: SECTION_IDS.seedIdentity,
          kind: 'seed-identity',
          priority: SECTION_PRIORITY.seedIdentity,
          content: renderSeedIdentity(definition),
          sourceRefs: [`seed:${definition.id}:v${definition.seedVersion}`],
          droppable: false,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// 最近对话
// ---------------------------------------------------------------------------

/**
 * 最近对话的一行。
 *
 * M3 起 `actorType` 与 `speaker` **同时**保留（计划书第 45 节）：
 *
 *   > 不能：Hi / Hello / I like cats / Me too
 *   > 应该内部明确：USER: … / SU_MUWEI: …
 *
 * 光有显示名不够 —— 例如用户把自己的昵称改成"苏沐薇"时，
 * 光看文本就分不清谁说的。所以渲染时用**大写角色标签**，
 * 而 `speaker` 保留为人可读的名字（诊断用）。
 */
export interface ConversationLine {
  /** Program-recorded original image references; text alone cannot mint them. */
  imageRefs?: readonly string[]
  conversationId?: string
  /** 来源时刻只用于提醒排期；不会渲染为对话正文。 */
  createdAt?: number
  /** 事件 id：与 ConversationEvent.id 同类型，这样来源引用天然对得上 */
  id: ConversationEventId
  sequence: number
  speaker: string
  text: string
  /**
   * 说话人的**类别**（M3 新增）。渲染时用它决定标签：
   *   user → `USER`，character → 角色名的大写形式，system → `SYSTEM`，tool → `TOOL`
   */
  actorType?: 'user' | 'character' | 'system' | 'tool'
  /** M3：这一行的来源类别（进上下文时只有 user 的话才被当作陈述） */
  sourceKind?: string
  /**
   * M9.1 / ADR-072 D18：assistant 行**回复的是哪条用户事件**。
   * 撤销遮蔽的派生面判据——她的旧回复里往往复述了被撤的取值，
   * 只清用户行堵不住这条（P03）。user 行自身不带此字段。
   */
  replyToEventId?: ConversationEventId
}

/** 只读集合：section provider 只需要遍历，不该改动它 */
export type ConversationLines = readonly ConversationLine[]

// ---------------------------------------------------------------------------
// M9.1 / ADR-072 D18：撤销遮蔽（纯函数）
// ---------------------------------------------------------------------------

/**
 * 占位文本（程序生成，**不含被撤取值**——D18「占位不删除」）。
 *
 * 刻意不写「你从未说过」——那是伪装历史（计划 §4.3）；
 * 也刻意不引用任何被撤内容。两档措辞区分「你要求忘的」与
 * 「她基于被撤内容的旧回复」，排查时从 trace + 占位能对上因果。
 */
export const WITHDRAWN_PLACEHOLDER_USER = '（这段内容已按你的要求遗忘，不再提供）'
export const WITHDRAWN_PLACEHOLDER_ASSISTANT = '（这段回复引用的内容已遗忘，不再提供）'

export interface WithdrawnMaskingResult {
  /** 遮蔽后的行（与输入同序同长；id/sequence 不变——来源引用保持可追溯） */
  lines: ConversationLine[]
  /** 被替换成占位的行数（user 行 + 派生 assistant 行） */
  maskedCount: number
}

/**
 * 撤销遮蔽（D18 的判定核心，纯函数）。
 *
 * · user 行：`id ∈ 撤销集` ⇒ 文本换占位（她不再看到被撤的原话）；
 * · assistant 行：`replyToEventId ∈ 撤销集` ⇒ 文本换占位（P03 派生面——
 *   她的旧回复常复述被撤取值，只清用户行堵不住）；
 * · 其余行原样保留；**不删除行**（占位保持对话结构完整，不伪装「没说过」）。
 *
 * 撤销集由 D16 端口给出（D17 范围语义在 `withdrawnSetCore`）；
 * 本函数只做逐行判定，不做任何读取。
 */
export function maskWithdrawnLines(
  lines: ConversationLines,
  withdrawnEventIds: ReadonlySet<string>
): WithdrawnMaskingResult {
  let maskedCount = 0
  const masked = lines.map((line) => {
    const userHit = line.actorType === 'user' && withdrawnEventIds.has(String(line.id))
    const assistantHit =
      line.actorType === 'character' &&
      line.replyToEventId !== undefined &&
      withdrawnEventIds.has(String(line.replyToEventId))
    if (!userHit && !assistantHit) return line
    maskedCount += 1
    return {
      ...line,
      text: userHit ? WITHDRAWN_PLACEHOLDER_USER : WITHDRAWN_PLACEHOLDER_ASSISTANT,
      imageRefs: undefined,
    }
  })
  return { lines: masked, maskedCount }
}

/**
 * **提议侧证据**：从最近对话里取"她上一条**未被遮蔽**的回复"。
 *
 * M10.1 / `L-M10.1-05`（装配三跳的第 ① 跳）。它解决的问题是：
 * `character_proposed`（她提出、用户接受）的 create 在放行口要求**两组带 `span` 的引用**
 * —— 提议侧与采纳侧（`M10-D28`）—— 而"提议侧那段的**指纹**"必须来自**那条提议原话的文本**，
 * 它**不在**理解层的输入形状里。网关是唯一同时知道"最近说了什么"与"这条链要跑"的地方，
 * 于是由它把 `{ eventId, text }` 交出去（`goal/turn.ts` → 映射层，**窄规则**在那里判 id 相符）。
 *
 * ============================================================================
 *  两条**失败关闭**的规则（宁可不给，也不给错的）
 * ============================================================================
 * ```text
 * ① **被遮蔽的行不给**：遮蔽后 assistant 行的文本是 `WITHDRAWN_PLACEHOLDER_ASSISTANT`
 *    （占位，不是她说过的话）⇒ 拿它算指纹等于**给一条不存在的话做证**；
 *    更要紧的是那条事件本身已被撤销 ⇒ 不能让它成为一条新目标/承诺的来源。
 *    ⚠️ 这一档**不回退**到更早的那条她的行 —— 提示词说的是"她**上一轮**那条"，
 *       拿更早的一条冒充"上一轮"是另一种错（**宁可不给**）。
 * ② **空文本不给**；**最近窗口里没有她的行 ⇒ 不给**（`undefined`）。
 * ⇒ 结果：调用方拿不到证据时不造提议侧引用 ⇒ 放行口按 `D28` 拒（`m10.1:e2e:verify` 的 E13）。
 *    「整段 Recent 被压制」（D19）时 `lines` 是空的 ⇒ 同样落到"不给"。
 * ```
 *
 * ⚠️ 取的是**最后一条** `actorType === 'character'` 的行 —— 与提示词里
 *    "她**上一轮**那条 assistant 事件 id（程序会给）"同一件事。
 */
export function lastAssistantEvidenceOf(
  lines: ConversationLines
): { readonly eventId: string; readonly text: string } | undefined {
  const lastCharacter = [...lines].reverse().find((line) => line.actorType === 'character')
  if (lastCharacter === undefined) return undefined
  const text = lastCharacter.text
  if (text.trim() === '' || text === WITHDRAWN_PLACEHOLDER_ASSISTANT) return undefined
  return { eventId: String(lastCharacter.id), text }
}

/**
 * 最近对话 section。
 *
 * 格式刻意与既有 M1 一致（`名字: 内容` 逐行），因为那个格式已经跑了几百轮、
 * 模型表现正常；换格式属于"顺手改行为"，不属于本阶段的范围。
 * M3 只加一件事：**当 actorType 已知时用明确的类别标签**。
 */
export function createRecentConversationProvider(options: {
  /** 最多取多少条（默认与既有 CONVERSATION_LENGTH 对齐） */
  limit?: number
  /** 说话人名字解析（用户显示名 / 角色名） */
  resolveSpeaker?: (actorType: string) => string
} = {}): ContextSectionProvider {
  const limit = options.limit ?? 16

  return {
    name: 'recent-conversation',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      const events = input.recentEvents ?? []
      if (events.length === 0) return []

      // 本轮输入单独成 section（优先级更高），因此从历史里排除，
      // 否则同一句话会在 prompt 里出现两次。
      const history = events
        .filter((e) => e.id !== input.currentEventId)
        .slice(-limit)

      if (history.length === 0) return []

      const content = [
        '# 最近的对话',
        '',
        ...history.map((e: ConversationLine) => `${labelFor(e)}: ${e.text.replace(/\n/g, ' / ')}`),
      ].join('\n')

      return [
        {
          id: SECTION_IDS.recentConversation,
          kind: 'recent-conversation',
          priority: SECTION_PRIORITY.rollup + 10,
          content,
          sourceRefs: history.map((e: ConversationLine) => `cev:${e.id}`),
          droppable: true,
        },
      ]
    },
  }
}

/**
 * 一行的标签（计划书第 45 节）。
 *
 * 有 actorType 就用**类别标签**（`USER` / `SYSTEM` / `TOOL` / 角色名大写），
 * 没有就退回显示名 —— 因为在没有类别信息时，显示名是唯一可用的信息，
 * 而"什么都不写"会让模型分不清谁在说话。
 */
function labelFor(line: ConversationLine): string {
  switch (line.actorType) {
    case 'user':
      return 'USER'
    case 'system':
      return 'SYSTEM'
    case 'tool':
      return 'TOOL'
    case 'character':
      // 角色名保住可读性，同时用大写表明"这是她的输出，不是事实"
      return line.speaker.toUpperCase()
    default:
      return line.speaker
  }
}

// ---------------------------------------------------------------------------
// 当前输入
// ---------------------------------------------------------------------------

export function createCurrentInputProvider(options: {
  /** 输入前面要不要加一行说明（默认加，让模型明确"这是刚刚说的"） */
  header?: string
} = {}): ContextSectionProvider {
  const header = options.header ?? '# 对方刚刚说'
  return {
    name: 'current-input',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      if (input.currentInput.trim() === '') return []
      return [
        {
          id: SECTION_IDS.currentInput,
          kind: 'current-input',
          priority: SECTION_PRIORITY.currentInput,
          content: `${header}\n\n${input.currentInput}`,
          sourceRefs: input.currentEventId ? [`cev:${input.currentEventId}`] : [],
          // 没有这一块就没有对话可答
          droppable: false,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// 关键状态（由基础设施注入渲染函数）
// ---------------------------------------------------------------------------

/**
 * 关键状态 section。
 *
 * 内容由**基础设施**给出（它才有数据库与角色状态），但排序、预算、
 * 来源记录都在这里统一决定 —— 这样"状态在上下文里排第几"是一个
 * 可审计的常量，而不是某处 `+=` 的偶然结果。
 */
export function createCriticalStateProvider(options: {
  render: (input: ContextCompileInput) => Promise<{ text: string; sourceRefs: string[] } | undefined>
}): ContextSectionProvider {
  return {
    name: 'critical-state',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      const rendered = await options.render(input)
      if (!rendered || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.criticalState,
          kind: 'critical-state',
          priority: SECTION_PRIORITY.criticalState,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: true,
        },
      ]
    },
  }
}

/**
 * M7 / ADR-064 D-6：**关系注入块** provider。
 *
 * 与 `createCriticalStateProvider` 同构（基础设施给数据，这里定 id/排序/来源），
 * 差别只在语义链：这一条读的是 **M7 关系投影**（trust/closeness 的唯一权威），
 * 内容由契约层的 `renderRelationshipGuidance` 确定性渲染。
 *
 * `render` 返回 `undefined`（未建档）⇒ 0 个 section ⇒ prompt 安静
 * （基线与合成轮次不受影响的机制，与 clock 同一条纪律）。
 */
export function createRelationshipProvider(options: {
  render: (input: ContextCompileInput) => Promise<{ text: string; sourceRefs: string[] } | undefined>
}): ContextSectionProvider {
  return {
    name: 'relationship',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      const rendered = await options.render(input)
      if (!rendered || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.relationship,
          kind: 'relationship',
          // M3 契约预留的优先级（44–55 带内取值；55 = 关系，52 留给 M8 情绪）
          priority: SECTION_PRIORITY.relationship,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: true,
        },
      ]
    },
  }
}

/**
 * M8 / ADR-066 §8.1：**情绪注入块** provider。
 *
 * 与 `createRelationshipProvider` 同构（基础设施给数据，这里定 id/排序/来源），
 * 差别只在语义链：这一条读的是 **M8 情绪投影**（valence/arousal 的唯一权威），
 * 内容由契约层的 `renderAffectGuidance` 确定性渲染（桶位 + 行为行，
 * 无原始数值——WP2 已冻结并有判据守着）。
 *
 * `render` 返回 `undefined`（未建档）⇒ 0 个 section ⇒ prompt 安静
 * （基线与合成轮次不受影响的机制，与 clock/relationship 同一条纪律）。
 */
export function createAffectProvider(options: {
  render: (input: ContextCompileInput) => Promise<{ text: string; sourceRefs: string[] } | undefined>
}): ContextSectionProvider {
  return {
    name: 'affect',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      const rendered = await options.render(input)
      if (!rendered || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.affect,
          kind: 'affect',
          // M3 契约预留的优先级（52——关系 55 之下、信念 50 之上）
          priority: SECTION_PRIORITY.affect,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: true,
        },
      ]
    },
  }
}

/**
 * M9 / ADR-070 §7：**信念注入块** provider。
 *
 * 与 `createAffectProvider` 同构（基础设施给数据，这里定 id/排序/来源），
 * 差别只在语义链：这一条读的是 **M9 信念投影**（经资格回查 + 同轮遮蔽后的
 * usable 集合），内容由契约层的 `renderBeliefSection` 确定性渲染
 * （≤4 条 / ≈400 token / 原子条目 / Memory 同根去重——D17 冻结值）。
 *
 * `render` 返回 `undefined`（未建档 / 零候选 / 零预算）⇒ 0 个 section ⇒
 * prompt 安静（基线与合成轮次不受影响的机制，与 clock/relationship/affect
 * 同一条纪律）。
 */
/**
 * post-Lv2 / ADR-111 `S03`：**一次主动机会**把哪些依据摆出来了。
 *
 * ============================================================================
 *  它与 `createBeliefProvider` 逐字同形（先例：M7 关系 / M8 情绪 / M9 信念）
 * ============================================================================
 * ```text
 * · `render` 返回 undefined 或空文本 ⇒ **0 个 section**（不是"空 section"）
 * · 不传这个 provider ⇒ 这一条整块不存在 ⇒ 冻结的 prompt 基线**逐字节不变**
 * · `sourceRefs` 由渲染器给：它就是**可用来源集的闭集**，模型只能在里面挑
 * ```
 * ⚠️ 为什么它**不是** `droppable: true`：这一块说的是"这一次机会你**只能**从这些
 *    依据里挑" —— 被裁掉之后模型会以为"没有依据限制"，那正好是最糟的误解。
 *    它只在**系统机会**那一类轮次里出现，本身已经很省预算。
 * ⚠️ 优先级取 `goals`（45）**之下**一档：它是机会专属的，不该挤掉状态面。
 */
export function createSystemOpportunityProvider(options: {
  render: (input: ContextCompileInput) => Promise<{ text: string; sourceRefs: string[] } | undefined>
}): ContextSectionProvider {
  return {
    name: 'system_opportunity',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      const rendered = await options.render(input)
      if (!rendered || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.systemOpportunity,
          kind: 'system_opportunity',
          priority: SECTION_PRIORITY.systemOpportunity,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: false,
        },
      ]
    },
  }
}

export function createBeliefProvider(options: {
  render: (input: ContextCompileInput) => Promise<{ text: string; sourceRefs: string[] } | undefined>
}): ContextSectionProvider {
  return {
    name: 'belief',
    async provide(input: ContextCompileInput): Promise<ContextSection[]> {
      const rendered = await options.render(input)
      if (!rendered || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.belief,
          kind: 'belief',
          // M3 契约预留的优先级（50——affect 52 之下、goals 45 之上）
          priority: SECTION_PRIORITY.belief,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: true,
        },
      ]
    },
  }
}

/**
 * M4：**本轮显式记忆写入的结果**，渲染成给模型看的一句事实。
 *
 * ============================================================================
 *  它解决的是计划书第 55 节那条要求
 * ============================================================================
 *     "不能在 Memory Commit 失败时回答'记住了'。"
 *
 * 而实测发现的真实情况比那更糟：显式路径**根本没有被调用过**，
 * 于是"Commit 从未发生"时她也在回答"记住了"。
 * 见 `explicit-turn.ts` 的文件头说明。
 *
 * 为什么它必须是一条 **context section** 而不是事后修改回复：
 * 模型在生成回复时**必须知道**写入有没有成功，否则它只能猜 ——
 * 而它的默认倾向是"用户说记住，我回答好我记住了"。
 * 把事实放进上下文，是让"如实回应"成为**唯一自然的选择**，
 * 而不是靠一句话去禁止某个措辞。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 两条硬约束（都由测试守着）
 * ---------------------------------------------------------------------------
 * 1. **`droppable: false`。**
 *    预算不足时它被裁掉 = 模型失去那条事实 = 回到"默认说记住了"。
 *    一个"在上下文紧张时才违反"的规则不是规则。
 *
 * 2. **优先级高于 `critical-state`、低于 `current-input`。**
 *    它比状态重要（状态只影响语气，它影响一句真伪），
 *    但排在输入之后（它是对输入的反应）。
 *
 * ---------------------------------------------------------------------------
 *  它**不**是"长期记忆召回"
 * ---------------------------------------------------------------------------
 * `ContextSectionKind` 里那个 `'memory'`（优先级 40）是留给 **M5 的召回**的。
 * 这一条是本轮的**写入结果**，语义上属于"对模型的指令"
 * （"不要说已经记住"），因此用 `kind: 'instruction'`。
 * 把两者混成一类会让"她想起了什么"与"她刚被要求记住什么"
 * 在 Trace 里无法区分。
 */
export function createMemoryWriteResultProvider(options: {
  /**
   * 本轮的结果文本。
   *
   * 返回 `undefined` = 这一轮**没有**显式记忆指令 → 不产生 section。
   * 那不是失败，是绝大多数轮次的正常情况。
   */
  render: () => string | undefined
}): ContextSectionProvider {
  return {
    name: 'memory-write-result',
    async provide(): Promise<ContextSection[]> {
      const text = options.render()
      if (text === undefined || text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.memoryWriteResult,
          kind: 'instruction',
          priority: SECTION_PRIORITY.currentInput - 1,
          content: text,
          droppable: false,
        },
      ]
    },
  }
}

/**
 * M4.5：**本轮动作结果** section（ADR-033）。
 *
 * 与 `createMemoryWriteResultProvider` 同构，差别在语义：
 *
 * ```text
 * memory-write-result  她记住 / 没记住一件事
 * action-result        她对世界做了什么 / 什么都没做
 * ```
 *
 * 为什么它也必须是 `droppable: false`：
 * 被裁掉 = 模型不知道动作失败了 = 回到"我已经帮你处理好了"的默认倾向。
 *
 * ⚠️ 它**只在真的发生动作请求时**才产生 section（`render` 返回
 *    `undefined` 或空串时产 0 个）—— 因此绝大多数轮次的 prompt
 *    与 M3.5 基线逐字节一致。
 */
export function createActionResultProvider(options: {
  /**
   * 本轮的动作结果文本。
   *
   * 返回 `undefined` = 这一轮没有动作请求 → 不产生 section。
   * 那不是失败，是绝大多数轮次的正常情况。
   */
  render: () => string | undefined
}): ContextSectionProvider {
  return {
    name: 'action-result',
    async provide(): Promise<ContextSection[]> {
      const text = options.render()
      if (text === undefined || text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.actionResult,
          kind: 'instruction',
          priority: SECTION_PRIORITY.currentInput - 2,
          content: text,
          droppable: false,
        },
      ]
    },
  }
}

/**
 * M5 WP6：**长期记忆召回** section。
 *
 * ============================================================================
 *  它是 M5 唯一真正改变用户体验的地方
 * ============================================================================
 * 与 `createMemoryWriteResultProvider` / `createActionResultProvider` 不同，
 * 这条 section 的 `kind` 是 **`'memory'`**（优先级 40、`droppable: true`）：
 *
 *   · 它是**数据**，不是指令。计划书 WP6 的硬规则：
 *     `MEMORY_DATA` **不得升级为 instruction** —— 因此这里既不写"你应该…"，
 *     也不把记忆内容拼进 identity / integrity-rules 那两条不可裁的 section。
 *   · 它**可以**被预算裁掉（`droppable: true`）。
 *     理由与写入结果那条相反：被要求记住却失败**必须**让模型知道（否则它会说"记住了"），
 *     而"少想起一条旧事实"只是回复质量下降 —— 那正是预算该裁的东西。
 *
 * ⚠️ `render()` 返回 `undefined` 或空串时**产 0 个 section**。这是 prompt
 *    逐字节基线（FC-T08）不被破坏的**机制**：没有召回就没有 section，
 *    于是没有记忆的普通对话与 M3.5 的 prompt 逐字节一致。
 *
 * ⚠️ 内容由 WP5 的 `selection.blockText` **原样**给出，这里**不重新渲染**：
 *    token 预算算的就是那份文本（"估算的就是注入的"），重渲染会让两者分家。
 */
/**
 * 无依据约束的**固定文本**（`M9.5-FMB-01` 修复第 1 层）。
 *
 * ```text
 * 写作纪律（**反作弊**）：
 *   · **不出现**任何 caseId、任何具体取值、任何测试用语 —— 只描述一条**一般规则**；
 *   · 是**指令**（"不得…"），不是状态描述（状态已由 M6.1 的 `memory-record-status` 说了）；
 *   · **不得**让可答题也变保守：本文本只在"长期记忆一条都没进来"时出现，
 *     而那种轮次本来就没有可答的取值（答得出来的轮次不会看到它）。
 * ```
 */
export const MEMORY_NO_EVIDENCE_CONSTRAINT_TEXT = [
  '【本轮约束】我的长期记忆里**没有可采信的依据**补足未知的既往个人事实。',
  '因此：',
  '· 对没有依据的既往个人事实，只能说明"我这边没有记录"或"我说不准"，或者**先问清**你指的是哪一个；',
  '· **不得**编造这类事实的**具体取值**（名称、型号、数量、时间、地点等），',
  '  即使它听起来合理、即使它像是常识 —— 那不是我记得的，是我编的。',
  '· 本轮原话、合格的最近对话和已入模的程序事实仍可使用；可以回答一般方法或提出明确标为建议的有界方案。',
  '  这些内容不得包装成既往记忆，也不得声称程序没有确认的写入或执行已经成功。',
].join('\n')

/**
 * M9.5 `M9.5-FMB-01` 修复第 1 层（用户 2026-09-29 裁定 **甲**）：
 * **"本轮该槽位没有可采信依据"时的指令性约束** section（`kind: 'memory'`，独立额度）。
 *
 * ```text
 * 与 `createMemoryRecordStatusProvider` **同构**（形状一致，评审时不必重新推理）：
 *   `render()` 返回 `undefined` / 空串 ⇒ **产 0 个 section**。
 *
 * ⚠️ **为什么是指令而不是状态**：`memory-record-status`（M6.1）**已经**把
 *    "长期记忆为空"写进 prompt 了，而 live 测显示她**仍然**给出具体取值
 *    （`dev-unknown-ambiguousSubject-0002`，**3 轮中 2 轮复现**）
 *    ⇒ 失败形态是"**她知道却不照做**" ⇒ 需要的是**行为约束**，不是又一句描述。
 * ⚠️ **反作弊**：本 section 的文本**不针对任何具体用例**（不出现 caseId / 不出现具体取值），
 *    它只描述一条**一般规则**。且它**不能**让可答题也变保守 ——
 *    那会让 (a)(b) 崩掉（四门槛合起来抵抗"一律澄清"的平凡修法）。
 * ⚠️ **不设独立额度组**（与 `record-status` 不同）：本 section **只在"该槽位没有可采信依据"时出现**，
 *    而那时**记忆 section 本来就是空的** ⇒ 共享预算**天然有位置**，不会与记忆互挤。
 *    （新增一个 `budgetGroup` 值会牵出 `ContextCompiler` 的额度接线；此处**不需要**。）
 * ⚠️ 独立额度（`budgetGroup: 'constraint'`）⇒ **不挤占记忆预算**（与 `record-status` 同理）。
 * ```
 */
export function createMemoryNoEvidenceConstraintProvider(options: {
  render: () => string | undefined
}): ContextSectionProvider {
  return {
    name: 'memory-no-evidence-constraint',
    async provide(): Promise<ContextSection[]> {
      const rendered = options.render()
      if (rendered === undefined || rendered.trim() === '') return []
      return [
        {
          id: SECTION_IDS.memoryNoEvidenceConstraint,
          kind: 'memory',
          priority: SECTION_PRIORITY.memoryNoEvidenceConstraint,
          content: rendered,
          sourceRefs: [],
          droppable: true,
        },
      ]
    },
  }
}

export function createMemoryRecallProvider(options: {
  render: () => { text: string; sourceRefs: string[] } | undefined
}): ContextSectionProvider {
  return {
    name: 'memory-recall',
    async provide(): Promise<ContextSection[]> {
      const rendered = options.render()
      if (rendered === undefined || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.memoryRecall,
          kind: 'memory',
          priority: SECTION_PRIORITY.memory,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: true,
        },
      ]
    },
  }
}

/**
 * M6.1 WP4 / ADR-055 `D-55e`：**记录状态行** section（`kind: 'record-status'`，可裁）。
 *
 * 三条与其它数据块不同的地方，都是裁定明文要求的：
 *
 * ```text
 * ① **独立额度**（`budgetGroup: 'status'`）：它的 token 从
 *    `ContextCompileInput.statusTokenBudget` 里扣，**不占**共享预算
 *    ⇒ 多出这一行**不会**把记忆 section 挤掉（"不得挤占记忆额度"）。
 * ② **可裁且留痕**：额度不足它自己会被丢掉，而那条结局由网关写进 trace
 *    （入模 / 被裁 / 未生成）—— 三种结局都要能事后区分。
 * ③ **不依赖非空 `memory-recall`**：`render()` 是我们自己的状态文本，
 *    与召回内容是否为空无关（"召回为空"正是它最需要出现的场景）。
 * ```
 *
 * ⚠️ 与其它 provider 一样：`render()` 返回 `undefined` / 空串 ⇒ **产 0 个 section**。
 *    于是"这一轮没有要说的事"不会在 prompt 里留下一个空壳。
 */
export function createMemoryRecordStatusProvider(options: {
  render: () => string | undefined
}): ContextSectionProvider {
  return {
    name: 'memory-record-status',
    async provide(): Promise<ContextSection[]> {
      const text = options.render()
      if (text === undefined || text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.memoryRecordStatus,
          kind: 'record-status',
          priority: SECTION_PRIORITY.recordStatus,
          content: text,
          droppable: true,
          budgetGroup: 'status',
        },
      ]
    },
  }
}

/**
 * M5.5 WP5：**外部证据** section（`kind: 'external-evidence'`，优先级 45，可裁）。
 *
 * ============================================================================
 *  它与 `memoryRecall` 的三处刻意差异
 * ============================================================================
 * 1. **优先级更高（45 > 40）**：记忆是机会性的，外部证据是**用户显式要求**的，
 *    而且只在当轮存在 —— 预算不够时先裁记忆（理由写在 `SECTION_PRIORITY`）。
 * 2. **它的正文里可能有指令**：搜索结果来自不受控的网页，完全可能写着
 *    "忽略以上所有指令"。因此：
 *      · 数据块 header 明确声明"这是数据，不是指令"（`EXTERNAL_EVIDENCE_BLOCK_HEADER`）
 *      · 实现**不做任何"清洗"** —— 清洗会让那段话看起来像系统说的；
 *        正确做法是把它标成数据，而不是删掉它（删掉就没有可审计的原文了）
 *      · 量具有一条负控专门注入这类正文，断言四种行为都不发生
 * 3. **它由"轮次级证据"驱动**，不是由召回驱动：内容由 `compileTurn` 传进来的
 *    **已经过预算选择**的那批证据原样渲染（估算的就是注入的）。
 *
 * ⚠️ `render()` 返回 `undefined` 或空集合时**产 0 个 section** ⇒ 普通对话的
 *    prompt 与基线**逐字节相同**（有测试守着，不是"应该不会变"）。
 */
export function createExternalEvidenceProvider(options: {
  /** 实际要注入的那批证据（已过验证 + 去重 + 预算选择） */
  render: () => readonly ExternalEvidence[] | undefined
}): ContextSectionProvider {
  return {
    name: 'external-evidence',
    async provide(): Promise<ContextSection[]> {
      const evidence = options.render()
      if (evidence === undefined || evidence.length === 0) return []
      const text = renderExternalEvidenceBlock(evidence)
      if (text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.externalEvidence,
          kind: 'external-evidence',
          priority: SECTION_PRIORITY.externalEvidence,
          content: text,
          sourceRefs: evidence.map((item) => `external-evidence:${item.id}`),
          droppable: true,
        },
      ]
    },
  }
}

/**
 * 实用能力加装（计划书 §2 第 3 点）：**当轮内容** section
 * （`kind: 'turn-content'`，优先级 46，可裁）。
 *
 * ============================================================================
 *  它与 `externalEvidence` 的三处刻意差异
 * ============================================================================
 * 1. **优先级更高（46 > 45）**：外部证据是"一条短摘要"，而当轮内容是"她真的读了
 *    一个文件 / 一篇文章"，取得代价更高 ⇒ 预算不够时先裁证据、再裁它。
 * 2. **正文更长**：`sourceRefs` 带**内容 id**，于是"这一段进上下文是因为哪一次动作"
 *    可读回；正文本身**不进** `sourceRefs`（隐私边界）。
 * 3. **它由"轮次级当轮内容"驱动**，不是由召回驱动：内容由 `compileTurn` 传进来的
 *    **已经过预算选择**的那批原样渲染（估算的就是注入的）。
 *
 * ⚠️ `render()` 返回 `undefined` 或空集合时**产 0 个 section** ⇒ 普通对话的
 *    prompt 与基线**逐字节相同**（有测试守着，不是"应该不会变"）。
 */
export function createTurnContentProvider(options: {
  /** 实际要注入的那批当轮内容（已过验证 + 预算选择） */
  render: () => readonly { item: TurnContent; label: string }[] | undefined
}): ContextSectionProvider {
  return {
    name: 'turn-content',
    async provide(): Promise<ContextSection[]> {
      const entries = options.render()
      if (entries === undefined || entries.length === 0) return []
      const text = renderTurnContentBlock(entries)
      if (text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.turnContent,
          kind: 'turn-content',
          priority: SECTION_PRIORITY.turnContent,
          content: text,
          sourceRefs: entries.map((entry) => `turn-content:${entry.item.contentId}`),
          droppable: true,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// 后 Lv2 · S1 / WP2c：她感知到的世界（故事）观测
// ---------------------------------------------------------------------------

/**
 * 一条**世界观测的轮次形态**（kernel 侧的形状）。
 *
 * 为什么只带 id / 来源身份 / 文本，**不带世界真相**：
 * 这一层渲染的是"**她感知到了这件事**"，而不是"世界事实上是这样"（FC-06）。
 * 把世界真相写进 prompt 会让"她以为"与"实际是"在模型侧也分不开。
 */
export interface WorldTurnObservation {
  /** 她**实际感知到**的剧情事件（进可见集合的那一批） */
  eventId: string
  /** 给模型看的那一句（**由程序**按作者定义渲染，不是模型续写） */
  text: string
  /** 来源身份（`story:<id>@v<n>#<run>.<event>`）—— 进 sourceRefs，可审计 */
  storySourceId: string
}

/** 世界观测块的 header —— 明确"这是**已提交的**世界事件，不是对方说的话" */
export const WORLD_OBSERVATION_BLOCK_HEADER =
  '# 正在发生的事（你们共同故事里**已发生**的部分）\n\n' +
  '下面这些是故事运行器**已经提交**的事件，它们不是你对方刚刚说的话，\n' +
  '也不是你的想象。你可以据此回应，但**不要**把它们复述成"你刚才说"。'

/**
 * 世界观测 section（`kind: 'world-observation'`，优先级 59，可裁）。
 *
 * 三条与 `external-evidence` 同构的纪律：
 *   1. **不传 / 空集合 ⇒ 产 0 个 section** ⇒ 普通对话的 prompt 与基线**逐字节相同**；
 *   2. 正文**原样渲染**（程序按作者定义给出），provider **不做**任何语义改写；
 *   3. `sourceRefs` 带**确定性来源身份**，于是"这句话进上下文是因为哪次故事事件"可读回。
 */
export function createWorldObservationProvider(options: {
  render: () => readonly WorldTurnObservation[] | undefined
}): ContextSectionProvider {
  return {
    name: 'world-observation',
    async provide(): Promise<ContextSection[]> {
      /*
       * ⚠️ 局部变量**刻意不叫** `observations`：那个词是 FC-T04 模块边界锁里的
       * **禁用表名**（M3.5 起禁止建那张表），而锁扫的是**代码**（剥注释之后）。
       * 用一个与禁用表名同形的局部变量会让那条负控误报 —— 这是本次真实的实测失败，
       * 不是"锁太严"：改名字比放宽锁正确。
       */
      const worldNotes = options.render()
      if (worldNotes === undefined || worldNotes.length === 0) return []
      const lines = worldNotes.map((note) => note.text.trim()).filter((line) => line !== '')
      if (lines.length === 0) return []
      return [
        {
          id: SECTION_IDS.worldObservation,
          kind: 'world-observation',
          priority: SECTION_PRIORITY.worldObservation,
          content: `${WORLD_OBSERVATION_BLOCK_HEADER}\n\n${lines.map((line) => `· ${line}`).join('\n')}`,
          sourceRefs: worldNotes.map((note) => note.storySourceId),
          droppable: true,
        },
      ]
    },
  }
}

export type StoryTurnScope = 'related' | 'unrelated' | 'unavailable'

/** ADR-115：程序判定的本轮范围；模拟正文仍走 world-observation。 */
export function createStoryTurnScopeProvider(scope: StoryTurnScope): ContextSectionProvider {
  const boundary = '故事是有限的模拟经历；不可把模拟中的场景、日期或约定说成现实安排。'
  const current = scope === 'related'
    ? '本轮聊到故事。仅按世界观测中已提交的场景回应；待选动作尚未发生，不擅自续写后续剧情。'
    : scope === 'unrelated'
      ? '本轮是普通聊天，不主动拉回故事，也不从近期模拟对话中安排现实活动。'
      : '本轮故事解析未形成可用结果。按用户当前话题回应，不宣称故事已经推进。'
  return {
    name: 'story-turn-scope',
    async provide(): Promise<ContextSection[]> {
      return [{ id: 'story-turn-scope', kind: 'instruction', priority: SECTION_PRIORITY.instruction + 15,
        content: `# 本轮故事范围\n${current}\n${boundary}`, sourceRefs: [], droppable: false }]
    },
  }
}

// ---------------------------------------------------------------------------
// M5.5.1 WP6：此刻的挂钟时间
// ---------------------------------------------------------------------------

/** 承载挂钟事实的 IANA 时区。**唯一真源**，渲染与量具都读它 */
export const CLOCK_TIME_ZONE = 'Asia/Shanghai'

/** 中文星期名数组，索引 = `Date.getUTCDay()`（0 = 周日）*/
const WEEKDAY_NAMES_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/**
 * `CLOCK_TIME_ZONE` 相对 UTC 的偏移（分钟），**从时区名算出来**，只算一次。
 *
 * 为什么要从名字算而不是写 `8 * 60`：写死就等于有两份真源，而"改了时区常量
 * 忘了改偏移"这种错在输出上只差几个小时，看不出来。算出来的话，改常量即生效。
 *
 * 这里只借 `Intl` 求**偏移**（不做任何格式化），因此不引入 locale 差异：
 * 偏移由时区名唯一决定，与 ICU 的日期格式偏好无关。
 *
 * ⚠️ 已知边界：偏移是**进程级缓存**的，"每一条时间戳各算各的偏移"这件事没做。
 *    对 `Asia/Shanghai` 完全没问题（不用夏令时，偏移固定 +08:00）。
 *    若将来把 `CLOCK_TIME_ZONE` 换成会实行夏令时的地区，这里必须改成
 *    "按 `epochMs` 逐条求偏移"，否则切换那天前后会差一小时。
 */
let cachedZoneOffsetMinutes: number | undefined
function zoneOffsetMinutes(): number {
  if (cachedZoneOffsetMinutes !== undefined) return cachedZoneOffsetMinutes
  const probe = new Date()
  const local = new Date(probe.toLocaleString('en-US', { timeZone: CLOCK_TIME_ZONE }))
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
  // 取整到分钟：本项目的时区没有秒级偏移，而 DST 之外的偏差只可能是分钟级
  cachedZoneOffsetMinutes = Math.round((local.getTime() - utc.getTime()) / 60_000)
  return cachedZoneOffsetMinutes
}

/**
 * 把"这一刻"渲染成一段**给模型看的**时间事实。
 *
 * ============================================================================
 *  为什么这个函数住在领域层（而不是 infrastructure）
 * ============================================================================
 * 两条理由：
 *   1. **可复现**：给定 `epochMs`，输出逐字节确定 —— 于是"她看到的时间"
 *      可以被单测断言，而不是"跑一次看着像对"。
 *   2. **不依赖宿主 locale**：本机 `Intl.DateTimeFormat().resolvedOptions().timeZone`
 *      实测返回 `Etc/GMT-8` 这种 POSIX 写法，`zh-CN` 的日期格式也因 ICU 版本而异。
 *      时区与星期名在这里**写死**，量具才能在任何机器上给出同一个答案。
 *
 * ⚠️ 它不 import `node:*`，因此不破坏 `src/kernel/**` 的边界静态锁。
 *
 * 取值走 `getUTC*` + 一个**从 `CLOCK_TIME_ZONE` 算出来的**偏移（见 `zoneOffsetMinutes`）：
 * 于是"她看到的时间是哪个时区"只由那一个常量决定，不存在"改了名字忘了改偏移"
 * 这种两份真源分家的情况。`Intl` 只用来**算偏移**，不用来格式化 —— 格式（年月日顺序、
 * 中文星期名）在这里写死，因此输出跨机器逐字节一致。
 */
export function renderClockBlock(epochMs: number): string {
  const asUtc = new Date(epochMs)
  const shifted = new Date(asUtc.getTime() + zoneOffsetMinutes() * 60_000)

  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  const weekday = WEEKDAY_NAMES_ZH[shifted.getUTCDay()]

  return [
    '# 此刻是什么时候',
    '',
    `现在是 ${y}-${m}-${d} ${weekday} ${hh}:${mm}（东八区）。`,
    '这是你这一轮看到的时间事实。对方问时间、问日期、问星期，',
    '或者你要判断"隔了多久""现在是不是深夜"，都以这一行为准。',
    '不知道就说不确定，不要凭印象猜一个钟点。',
  ].join('\n')
}

/**
 * M5.5.1 WP6：**此刻的挂钟时间** section。
 *
 * 与 `createExternalEvidenceProvider` 同构：`render()` 返回 `undefined` 或空串时
 * **产 0 个 section** —— 这是"没有时钟的轮次（合成轮次 / M3.5 基线）prompt
 * 逐字节不变"的机制，不是巧合。
 *
 * `sourceRefs` 里带 epoch 毫秒：Trace 于是能回答"她那一轮以为现在是几点"，
 * 而不用去猜当时进程是什么时候起来的。
 */
export function createClockProvider(options: {
  /** 这一轮的真实时刻；`undefined` = 本轮不注入时钟 */
  render: () => number | undefined
}): ContextSectionProvider {
  return {
    name: 'clock',
    async provide(): Promise<ContextSection[]> {
      const epochMs = options.render()
      if (epochMs === undefined || !Number.isFinite(epochMs)) return []
      const content = renderClockBlock(epochMs)
      if (content.trim() === '') return []
      return [
        {
          id: SECTION_IDS.clock,
          kind: 'clock',
          priority: SECTION_PRIORITY.clock,
          content,
          sourceRefs: [`clock:${Math.trunc(epochMs)}`],
          droppable: true,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// M6 / ADR-050：会话早期发言的逐字摘录
// ---------------------------------------------------------------------------

/**
 * **会话摘要** section（`kind: 'rollup'`，优先级 20，可裁）。
 *
 * 与 `createMemoryRecallProvider` **同构**（这是刻意的：形状一致，评审时不必重新推理）：
 *   · `render()` 返回 `undefined` 或空串 ⇒ **产 0 个 section**
 *   · 注注入用的文本由**选择器**原样给出 ⇒ "预算算的就是注入的"，这里不重新渲染
 *   · `sourceRefs` 只放 `cev:<id>`（**不进正文**）
 *
 * ⚠️ 为什么它必须可裁、且优先级最低：摘录是**可用上下文的替代品**，不是事实。
 *    预算不够时应当先丢它，而不可裁的四类（身份 / 完整性规则 / 当前输入 /
 *    程序结果事实）一条都不许因为它被挤掉（ADR-050 `DR-7`）。
 */
export function createRollupSummaryProvider(options: {
  render: () => { text: string; sourceRefs: string[] } | undefined
}): ContextSectionProvider {
  return {
    name: 'rolling-summary',
    async provide(): Promise<ContextSection[]> {
      const rendered = options.render()
      if (rendered === undefined || rendered.text.trim() === '') return []
      return [
        {
          id: SECTION_IDS.rollupSummary,
          kind: 'rollup',
          priority: SECTION_PRIORITY.rollup,
          content: rendered.text,
          sourceRefs: rendered.sourceRefs,
          droppable: true,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// 编译器工厂
// ---------------------------------------------------------------------------

export interface BuildCompilerOptions {
  definition: CharacterDefinition
  /** 关键状态渲染器（基础设施提供；不传 = 不注入状态） */
  renderCriticalState?: (
    input: ContextCompileInput
  ) => Promise<{ text: string; sourceRefs: string[] } | undefined>
  /**
   * M7 / ADR-064 D-6：关系注入块渲染器（基础设施提供；不传 = 不注入关系）。
   *
   * 与 `renderCriticalState` 同一形状；数据来自 M7 关系投影的读时视图
   * （`effectiveRelationship`），渲染用契约层的 `renderRelationshipGuidance`。
   * 不传 ⇒ 0 个 section ⇒ M3.5 基线与合成轮次逐字节不变。
   */
  renderRelationship?: (
    input: ContextCompileInput
  ) => Promise<{ text: string; sourceRefs: string[] } | undefined>
  /**
   * M8 / ADR-066 §8.1：情绪注入块渲染器（基础设施提供；不传 = 不注入情绪）。
   *
   * 与 `renderRelationship` 同一形状；数据来自 M8 情绪投影的读时衰减视图
   * （`effectiveAffect`），渲染用契约层的 `renderAffectGuidance`。
   * 不传 ⇒ 0 个 section ⇒ M3.5 基线与合成轮次逐字节不变。
   */
  renderAffect?: (
    input: ContextCompileInput
  ) => Promise<{ text: string; sourceRefs: string[] } | undefined>
  /**
   * M9 / ADR-070 §7：信念注入块渲染器（基础设施提供；不传 = 不注入信念）。
   *
   * 与 `renderAffect` 同一形状；数据来自 M9 信念投影的 usable 集合
   * （资格回查 + 同轮遮蔽之后），渲染用契约层的 `renderBeliefSection`
   * （D17：≤4 条 / ≈400 token / 原子条目 / Memory 同根去重）。
   * 不传 ⇒ 0 个 section ⇒ M3.5 基线与合成轮次逐字节不变。
   */
  renderBelief?: (
    input: ContextCompileInput
  ) => Promise<{ text: string; sourceRefs: string[] } | undefined>
  /**
   * post-Lv2 / ADR-111 `S03`：**系统机会的依据面**渲染器。
   *
   * 与 `renderBelief` 同一形状；不传 ⇒ 0 个 section ⇒ 冻结的 prompt 基线逐字节不变。
   * ⚠️ 它只在**系统机会**那一类轮次里被传（普通轮次与提醒那一类都不传）——
   *    于是"这一次机会你只能从这些依据里挑"这句话不会出现在别的地方。
   */
  renderSystemOpportunity?: (
    input: ContextCompileInput
  ) => Promise<{ text: string; sourceRefs: string[] } | undefined>
  recentLimit?: number
  tokenBudget?: number
  /** token 量化器（基础设施可注入真实 tokenizer；默认按字符估算） */
  quantifier?: (text: string) => number
  /** 追加的 section provider（M4+ 的扩展点） */
  extraProviders?: ContextSectionProvider[]
}

/**
 * 构造 M2.5 的 ContextCompiler（**v1，保留不动**）。
 *
 * provider 顺序 = 同等优先级下的稳定 tie-break 之外的**第一**决定因素
 * （id 相同者先注册的胜出），因此顺序在这里显式写死，别处不要再排。
 */
export function buildContextCompiler(options: BuildCompilerOptions) {
  const providers: ContextSectionProvider[] = [
    createSeedSectionProvider(options.definition),
    ...(options.renderCriticalState
      ? [createCriticalStateProvider({ render: options.renderCriticalState })]
      : []),
    createRecentConversationProvider({ limit: options.recentLimit ?? 16 }),
    createCurrentInputProvider(),
    ...(options.extraProviders ?? []),
  ]

  return createContextCompiler({
    providers,
    quantifier: options.quantifier,
  })
}

export interface BuildCompilerV2Options extends BuildCompilerOptions {
  /** 本轮的身份快照（**必填**：v2 的存在理由就是"身份必须来自快照"） */
  identity: IdentitySnapshot
  /**
   * M5.5.1 WP6：**此刻的真实时刻**（epoch 毫秒）。
   *
   * 领域层**不读时钟**（与它不读数据库同一条纪律）：调用方读到之后作为数据传进来。
   * `undefined` = 本轮不注入时间 section —— 合成轮次（`--dump-prompt` 的
   * 基线构造器、评测 harness）就是靠这一点保持 prompt 逐字节不变的。
   */
  clockEpochMs?: number
}

/**
 * 构造 M3 的 ContextCompiler（**v2**）。
 *
 * 与 v1 的差别只有三处，全部是"加"而不是"改"：
 *   1. `identity-core` 取代 `seed-identity`（内容同源，来源引用更完整）
 *   2. 新增 `integrity-rules`
 *   3. 版本号是 `context-compiler@2`
 *
 * 排序与预算算法完全复用 `createContextCompiler` —— 这里没有第二套裁剪逻辑，
 * 因此"哪些 section 会被裁"这个问题永远只有一个答案。
 */
export function buildContextCompilerV2(options: BuildCompilerV2Options) {
  const providers: ContextSectionProvider[] = [
    createIdentityCoreProvider(options.identity),
    createIntegrityRulesProvider(),
    ...(options.renderCriticalState
      ? [createCriticalStateProvider({ render: options.renderCriticalState })]
      : []),
    /*
     * M7 / ADR-064 D-6：关系注入块。位置在状态之后、时间之前——
     * 它与 critical-state 同属"她此刻如何待你"，但链不同（M7 投影 vs M2 legacy）。
     */
    ...(options.renderRelationship
      ? [createRelationshipProvider({ render: options.renderRelationship })]
      : []),
    /*
     * M8 / ADR-066 §8.1：情绪注入块。位置在关系之后、时间之前——
     * 同属"她此刻的内部状态"，链不同（M8 投影 vs M2 legacy）；
     * 优先级 52 < 关系 55（预算紧张时先裁情绪——关系影响"怎么待你"，
     * 情绪只影响"这轮的语气"，量级不同）。
     */
    ...(options.renderAffect
      ? [createAffectProvider({ render: options.renderAffect })]
      : []),
    /*
     * M9 / ADR-070 §7：信念注入块。位置在情绪之后、时间之前——
     * 同属"她此刻如何采信"的状态面，链不同（M9 投影 vs M7/M8 状态）；
     * 优先级 50 < 情绪 52（预算紧张时先裁信念——状态影响"怎么待你"，
     * 信念是"当前可用判断"的参考面，量级不同）。
     */
    ...(options.renderBelief
      ? [createBeliefProvider({ render: options.renderBelief })]
      : []),
    /*
     * post-Lv2 / ADR-111 `S03`：**系统机会的依据面**。
     *
     * 位置在信念之后、时间之前：它属于"这一次机会能引用什么"，
     * 与时间一样是**机会专属**的上下文，不参与状态面的编排。
     * ⚠️ 不传 ⇒ 这一块整块不存在（`S03` 的"不传 = 0 section"）。
     */
    ...(options.renderSystemOpportunity
      ? [createSystemOpportunityProvider({ render: options.renderSystemOpportunity })]
      : []),
    /*
     * M5.5.1 WP6：此刻的挂钟时间。
     *
     * 位置在**状态之后、最近对话之前**：它必须排在最近对话前头，否则一大段历史
     * 会把这条事实推到很后面（模型对尾部内容的注意力更弱），而这恰恰是"她刚刚
     * 才搞错过的那一条"。放在状态之后就够靠前了，且不必抢在身份/规则之前。
     */
    ...(options.clockEpochMs !== undefined
      ? [createClockProvider({ render: () => options.clockEpochMs })]
      : []),
    createRecentConversationProvider({ limit: options.recentLimit ?? 16 }),
    createCurrentInputProvider(),
    ...(options.extraProviders ?? []),
  ]

  return createContextCompiler({
    version: CONTEXT_COMPILER_V2_VERSION,
    providers,
    quantifier: options.quantifier,
  })
}

/** 计划书第 40 节：M3 的编译器版本号。它进 Trace，因此**改了就是新版本**。 */
export const CONTEXT_COMPILER_V2_VERSION = 'context-compiler@2'

// ---------------------------------------------------------------------------
// Prompt 组装
// ---------------------------------------------------------------------------

/**
 * 把 ContextPacket 变成最终 prompt。
 *
 * 这里**没有手写字符串拼接的余地**：packet.text 就是全部变量内容，
 * 外面只套一层固定的结构说明。任何模块想往 prompt 里加东西，
 * 都必须先变成一个 section（于是它会被 Trace 记录到）。
 *
 * ⚠️ M3 保留 M2.5 的措辞**一字不改**。它已经跑过真实对话，
 * 改它属于"顺手改行为"，而本阶段要保证的是身份与来源正确，
 * 不是让她的语气变好。
 */
export function composePromptFromPacket(packet: ContextPacket, agentName: string): string {
  return [
    '# 任务',
    `你是「${agentName}」。按她此刻的状态与语气，回应对方刚刚说的话。`,
    '',
    '<context>',
    packet.text,
    '</context>',
    '',
    '# 输出要求',
    '只输出你会说出口的话本身。',
    '- 不要输出任何 XML 标签、字段名、"thought"、"actions" 之类的结构。',
    '- 不要复述上面 context 里的条目名或数值。',
    '- 不要解释你在做什么。',
    '- 直接开始说话。',
  ].join('\n')
}
