/**
 * M11（ADR-085 §4.4 / `D05` / `D31`）—— **派生链与原始根**的契约。
 *
 * ============================================================================
 *  这个文件回答一个问题："这条反思到底依据了**几件**真实经历？"
 * ============================================================================
 * ```text
 *   同一个 user event ─→ Memory ─→ Belief ─→ Reflection
 *            └────────────────────────────→ Reflection
 *   独立有效根计数：**1**；派生节点数：**不参与**增强支持
 * ```
 *
 * 为什么必须由**程序**算：模型看不见"这条记忆和我引用的那条信念其实是同一句话"。
 * 若按**节点数**计证，她把自己说过的话读三遍就等于三份独立支持 —— 那正是
 * `INV-CI-03`（维护不得伪装成经历）要防的退化，也是 `DomainEvent.causedByDomainEventIds`
 * 这个字段从 M2.5 就被预留的原因。
 *
 * ⚠️ 本模块是**纯的**：没有 SQL、没有 `node:*`、没有模型调用。取数一律走
 *    注入的 `LineageLookup`（形状照 `app/goal/inputs.ts` / `app/belief/eligibility.ts`
 *    的既有做法：按**确切 ID** 批量查，**禁止**用检索排名判断"存在与否"）。
 */

/** 一条来源引用的类型（WP3 的 source handle 就是由它构成）。 */
export type LineageHandleKind = 'conversation_event' | 'domain_event' | 'memory' | 'belief' | 'story_event'

/**
 * `LineageHandleKind` 的**登记值**（S8/ADR-093 `D04` 追加第五类；旧四类语义不变）。
 *
 * ⚠️ 之前没有这个常量，判据只能靠正则从类型别名里抠 —— 那是"读不到就静默放过"的形状。
 */
export const LINEAGE_HANDLE_KINDS: readonly LineageHandleKind[] = [
  'conversation_event',
  'domain_event',
  'memory',
  'belief',
  'story_event',
]

/**
 * **五类来源标签**（ADR-085 §4.4 ④）。
 *
 * ⚠️ `user_statement` 与 `user_report` 的区别**不是**这里能猜出来的：
 *    "用户在陈述"与"用户在报告某件事的结果"是**语义**判断，必须由调用方以
 *    **程序事实**（例如 M10 的 `completionBasis`）通过 `classHint` 传进来。
 *    本模块**不**做语义猜测；没有 hint 时按对话事件的 `actorType` 落到保守的那一类。
 */
export type LineageSourceClass =
  | 'user_statement'
  | 'user_report'
  | 'assistant_speech'
  | 'program_result'
  | 'internal_interpretation'
  /**
   * **后 Lv2 · S8 / ADR-093 `D04`**：故事亲历（模拟经历）。
   *
   * ⚠️ 它**不是** `user_report`：用户转述一件事与她自己经历一件事是两种来源
   * （计划书 §3.2：来源追问必须能区分）。追加第六类，旧五类语义不变。
   */
  | 'story_experience'

export const LINEAGE_SOURCE_CLASSES: readonly LineageSourceClass[] = [
  'user_statement',
  'user_report',
  'assistant_speech',
  'program_result',
  'internal_interpretation',
  'story_experience',
]

/** 调用方给的一条来源引用。 */
export interface LineageHandle {
  readonly kind: LineageHandleKind
  readonly id: string
  /**
   * 调用方**已知**的程序事实标签（例如"这条引用来自 `user_report` 依据"）。
   * 缺省 ⇒ 按节点自身可判的属性推断（对话事件看 `actorType`，其它落 `internal_interpretation`）。
   */
  readonly classHint?: LineageSourceClass
}

/** 展开后的一个**原始根**（去重后）。 */
export interface LineageRoot {
  /** 原始根 id（对话事件 id；故事根则是**提交身份** `…e<revision>`） */
  readonly id: string
  readonly sourceClass: LineageSourceClass
  /** 从任一 handle 到它的**最短**深度（诊断用，不参与计证） */
  readonly depth: number
  /**
   * **因果身份键**（ADR-093 `D05` + `R-4`；S8 追加）。
   *
   * ```text
   * 对话根          → 'conversation:' + conversationEventId
   * 故事根(user_choice) → 'conversation:' + anchorConversationEventId   ← 与对话根**同键**
   * 故事根(system)  → 'story-system:' + commitId                        ← 不合格为习惯根
   * ```
   *
   * ⚠️ **`rootCount` 按 `causalKey` 去重**，不是按 `id`：同一次选择的对话记录与故事提交
   * 是**两根 id、一个因果身份**（`S8-C02`）。旧对话链的 `causalKey = 'conversation:' + id`，
   * 因此**计数语义逐字不变**（`S8-A18`）。
   */
  readonly causalKey: string
  /**
   * 真实会话键（`D06`；S8 追加）。
   *
   * ```text
   * 对话根          → 该对话事件的 conversationId
   * 故事根(user_choice) → interactionRef（服务端绑定的真实会话）
   * 故事根(system)  → undefined（**不**贡献会话数）
   * ```
   */
  readonly sessionKey?: string
}

/**
 * 具名拒收理由（闭集）。
 *
 * ⚠️ 每一条都必须是"不可用于采纳"的**具体**原因；把两个原因合成一个是错的
 *    （先例：`goal-reference.ts` 明确写过 `forgotten` 与 `overlaid` **不得**合并）。
 */
export type LineageRejectionReason =
  | 'lineage_cycle'
  | 'lineage_limit_exceeded'
  | 'root_unresolvable'
  | 'node_missing'
  | 'node_foreign'
  | 'node_malformed'
  | 'handle_unknown'
  /** **S8 追加**（ADR-093 `D04`）：提交在账本里不存在（旧来源无账本 ⇒ 拒收，**不回填**） */
  | 'story_root_unconfirmed'
  /** 该条目**从来没可见过**（未选分支 / 隐藏节点 / 作者后台设定） */
  | 'story_root_invisible'
  /** `storyVersion` 与内容包/引用不匹配 —— 明确拒绝，绝不静默换剧情 */
  | 'story_root_version_mismatch'
  /** 认知使用资格已被撤回（读时判定，replay 不能绕过） */
  | 'story_root_withdrawn'
  /** `system` 提交（开场 / 后台推进）：是经历，但**不合格**为习惯根（`D05`/`D06`） */
  | 'story_root_not_interactive'

export interface LineageRejection {
  readonly reason: LineageRejectionReason
  /** 触发它的那个 handle / 节点 id（可追溯） */
  readonly at: string
  readonly detail: string
}

/** 每个理由的**可达性事实**（沿用 `REFERENCE_REJECTION_FACTS` 的纪律：谁产生的、怎么到）。 */
export interface LineageRejectionFact {
  readonly reason: LineageRejectionReason
  readonly producedBy: string
  readonly howToReach: string
}

export const LINEAGE_REJECTION_FACTS: readonly LineageRejectionFact[] = [
  {
    reason: 'lineage_cycle',
    producedBy: 'expandLineage()',
    howToReach: '旧数据的 `causedByDomainEventIds` 形成环（写侧不可能造环，见 D25 §④）',
  },
  {
    reason: 'lineage_limit_exceeded',
    producedBy: 'expandLineage()',
    howToReach: '深度 > 16 或展开节点 > 64（ADR `D30` 的冻结上限）',
  },
  {
    reason: 'root_unresolvable',
    producedBy: 'expandLineage()',
    howToReach: '一个派生节点既没有对话来源、也没有父事件（追不到原始经历）',
  },
  {
    reason: 'node_missing',
    producedBy: 'expandLineage()',
    howToReach: '某条边指向的节点在只读面里取不到（悬空引用）',
  },
  {
    reason: 'node_foreign',
    producedBy: 'expandLineage()',
    howToReach: '节点属于别的 character（跨角色引用）',
  },
  {
    reason: 'node_malformed',
    producedBy: 'expandLineage()',
    howToReach: '节点的边字段不是 id 数组（库里出现非数组的宽容读数）',
  },
  {
    reason: 'handle_unknown',
    producedBy: 'expandLineage()',
    howToReach: '调用方给了一个只读面里不存在的 handle id',
  },
  {
    reason: 'story_root_unconfirmed',
    producedBy: 'expandLineage()（S8）',
    howToReach: '故事提交在 `storyline_commits` 里查不到 —— 旧来源**没有账本**，按拒收处理（ADR-093 `D14`，不回填）',
  },
  {
    reason: 'story_root_invisible',
    producedBy: 'expandLineage()（S8）',
    howToReach: '该可见条目在账本里没有对应行（未选分支 / 隐藏节点 / 作者后台设定）',
  },
  {
    reason: 'story_root_version_mismatch',
    producedBy: 'expandLineage()（S8）',
    howToReach: '引用的 `storyVersion` 与账本行不一致（改了剧情却没升版本，或拿了别的版本的引用）',
  },
  {
    reason: 'story_root_withdrawn',
    producedBy: 'expandLineage()（S8）',
    howToReach: '认知使用资格被撤回（`STORY_EXPERIENCE_RETRACTED`）—— **读时**判定，replay 不能绕过',
  },
  {
    reason: 'story_root_not_interactive',
    producedBy: 'expandLineage()（S8）',
    howToReach: '`interaction_kind = system` 的提交（开场 / 后台推进）：可作经历，但**不**为习惯制造合格反馈（`D05`/`D06`）',
  },
]

/**
 * 只读面的一条读数（**最小信息**：只要追根需要的字段，不要正文）。
 *
 * 与 `ProposalSourceLookup` 同一口径：本模块不需要读聊天内容，
 * 因此它不会因为"读到正文"而承担额外责任。
 */
export interface LineageConversationReading {
  readonly id: string
  readonly characterId: string
  readonly conversationId: string
  readonly actorType: string
}

export interface LineageDomainEventReading {
  readonly id: string
  readonly characterId: string
  readonly causedByDomainEventIds: readonly string[]
  readonly sourceConversationEventIds: readonly string[]
  /**
   * **S8 / ADR-093 `D03`**：该内部事件 payload 里携带的故事来源引用（`sourceStoryRefs[].sourceId`）。
   *
   * ⚠️ 它**不**进 `sourceConversationEventIds`：后者永远只指对话事件（`S8-A05`）。
   * 缺字段（S8 之前的行）⇒ 读成"没有故事来源"，与旧行为逐字一致。
   */
  readonly sourceStoryEventIds?: readonly string[]
}

export interface LineageMemoryReading {
  readonly id: string
  /**
   * 归属角色；`undefined` = 该来源的归属**不由 character 表达**。
   *
   * ⚠️ 这不是"字段可选所以随便填"：记忆的归属在库里是 `owner_kind` / `owner_id`
   *    （可能是 character，也可能是 user），信念行则由**按角色作用域的查询**给出。
   *    `D25` ④ 的原话是"跨用户引用**按各来源的 subject/target 规则**复核"——
   *    因此本字段只在**该来源确实以 character 归属**时填；填了就要被查。
   */
  readonly characterId?: string
  /** 证据引用里的对话事件 id（`memory_evidence_links` 的 `is_root` 行） */
  readonly evidenceConversationEventIds: readonly string[]
  /**
   * **S8 追加**：证据引用里的**故事条目** id（`evidence_kind = 'story_event'` 的 `is_root` 行）。
   *
   * ⚠️ 与 `evidenceConversationEventIds` **分开**是必须的：两者的来源类不同
   * （`user_statement` vs `story_experience`），合并成一个数组就等于让追根器
   * 分不清"她听用户说的"与"她自己经历的"（ADR-093 `D04`）。
   */
  readonly evidenceStoryEventIds?: readonly string[]
}

export interface LineageBeliefReading {
  readonly id: string
  /** 同 `LineageMemoryReading.characterId`：行已按角色作用域读出时可留空 */
  readonly characterId?: string
  readonly evidenceRootIds: readonly string[]
  readonly dependsOnMemoryIds: readonly string[]
}

/**
 * **S8 追加**（ADR-093 `D04`）：一条故事提交的只读读数。
 *
 * 它是"故事经历能不能成为根"的**唯一**取数形状：不读剧情正文、不读作者设定，
 * 只读**账本里已存在的事实**与**服务端绑定的归属**。
 */
export interface LineageStoryEventReading {
  /** 提交身份 `story:<storyId>@v<ver>#<runId>.e<revision>` */
  readonly id: string
  /**
   * 调用方**实际给出的**引用 id（可能是观测 id，也可能是提交 id）。
   *
   * ⚠️ 两者都必须能解析到**同一条提交**（`S8-A02`：观测 → 父提交的映射）——
   * 因此读数以 `requestedId` 为键存放，而**因果身份**始终取 `id`（提交身份）。
   */
  readonly requestedId: string
  readonly storyId: string
  readonly storyVersion: number
  readonly runId: string
  readonly revision: number
  /** `user_choice` 才可能成为合格根；`system` 由 `story_root_not_interactive` 拒收 */
  readonly interactionKind: 'user_choice' | 'system'
  /** 触发这次提交的**真实对话事件**（`user_choice` 必有）——因果键的来源（`R-4`） */
  readonly anchorConversationEventId?: string
  /** 真实会话 id（`D06`；`system` 为 undefined） */
  readonly interactionRef?: string
  /** 该提交**是否真的可见**（账本里存在且属于本提交） */
  readonly visible: boolean
  /** 认知使用资格**是否已撤回**（读时判定） */
  readonly withdrawn: boolean
  /**
   * 引用里编码的 `storyVersion` 与账本行**不一致**。
   *
   * ⚠️ 这个判据在**取数实现**里算（那里才有解析来源 id 语法的权限：
   * `src/kernel/app/**` 不得 import `kernel/storyline/**`，见 FC-T04 的模块边界锁）。
   */
  readonly versionMismatch: boolean
}

/** 注入的只读取数口（**唯一**的取数边界；实现里才有 SQL）。 */
export interface LineageLookup {
  findConversationEvents(ids: readonly string[]): Promise<LineageConversationReading[]>
  findDomainEvents(ids: readonly string[]): Promise<LineageDomainEventReading[]>
  findMemories(ids: readonly string[]): Promise<LineageMemoryReading[]>
  findBeliefs(ids: readonly string[]): Promise<LineageBeliefReading[]>
  /** **S8 追加**：按提交身份批量取故事账本读数 */
  findStoryEvents?(ids: readonly string[]): Promise<LineageStoryEventReading[]>
}

/** 展开的结果。 */
export interface LineageResolution {
  /**
   * 去重后的**原始根**（按 `causalKey` 升序，确定性）。
   *
   * ⚠️ S8 起"去重"按 `causalKey`：同一次选择的对话根与故事根合成**一个**根。
   */
  readonly roots: readonly LineageRoot[]
  /** 有效独立根数 == `roots.length`（按 `causalKey` 去重后；`D05` 的第一个分量） */
  readonly rootCount: number
  /** 展开过的**派生节点**数（**不**参与增信，只作诊断） */
  readonly derivedNodeCount: number
  /** 每个来源类各命中几个**根** */
  readonly classCounts: Readonly<Record<LineageSourceClass, number>>
  /** 根落在几个**不同会话**里（`D06` 的第二个分量；按 `sessionKey` 去重） */
  readonly conversationCount: number
  /** 其中**故事根**有几个（S8 诊断用；**不**替代 `rootCount`） */
  readonly storyRootCount: number
  readonly rejections: readonly LineageRejection[]
  /** 没有任何拒收**且** rootCount > 0 ⇒ 才可用于采纳 */
  readonly usable: boolean
  /**
   * 本次**真的读了几条**记录（`measured_count` 自检的输入）。
   *
   * ⚠️ `0` ⇒ 调用方**必须**判 `MEASUREMENT INVALID`，**不是** PASS（AGENTS §6.8）。
   */
  readonly measuredCount: number
}

/** ADR-085 `D30` 冻结的遍历上限。 */
export const LINEAGE_MAX_DEPTH = 16
export const LINEAGE_MAX_NODES = 64
