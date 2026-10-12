/**
 * Source Provenance & Source Firewall 的契约 —— **这句话是哪一类内容**。
 *
 * ============================================================================
 *  计划书第 26–33 / 82–85 节：M3 是 Memory 之前的事实防火墙
 * ============================================================================
 * M3 **不建 Memory**（那是 M4）。它只做一件事：让每条事件都带着
 * **正确的来源标签**，于是 M4 的 Memory Extractor 面对的是可信的输入。
 *
 * 计划书第 0 节描述的污染链是真实会发生的事故：
 *
 *     Assistant hallucination → Memory extractor → "长期事实"
 *        → 未来 Context → 模型更加相信 → 再次写入        （自我强化错误）
 *
 * 阻断它的位置不在 M4，而在**写入事件的那一刻**：
 * 如果 `assistant_message` 从一开始就标着 `CHARACTER_GENERATION`，
 * 那么后面任何"把它升级成用户事实"的模块都必须**显式地**做这件事，
 * 而不是顺手做对、也不是顺手做错。
 *
 * ---------------------------------------------------------------------------
 *  source_kind 而不是 truth = true
 * ---------------------------------------------------------------------------
 * 计划书第 28 节给了最有说服力的例子：
 *
 *     用户："月球是奶酪做的。"
 *
 * 系统能确认的只有 `USER_REPORTED: 用户声称月球是奶酪做的`，
 * **不能**自动确认 `WORLD_FACT: 月球是奶酪做的`。
 *
 * 所以这里从头到尾没有任何 `truth` 字段。有的只是"这条内容从哪来"。
 */

import { KernelError } from './ids.ts'
import type { ActorType } from './actor.ts'

// ---------------------------------------------------------------------------
// SourceKind —— 事实类别（不是语义类别）
// ---------------------------------------------------------------------------

/**
 * 计划的第 27 节：M3 不做 Memory 分类，但必须做**来源分类**。
 *
 * 这四个值是**事实类别**，判断它们不需要理解内容：
 * 只看"这条事件是从哪条路径进来的"就够。
 */
export type SourceKind =
  /** 用户说的话（陈述、提问、确认……） */
  | 'user_statement'
  /** 她自己生成的话（模型产出，**不是**事实） */
  | 'character_output'
  /** 系统指令 / 系统通知（**不是**她的经历） */
  | 'system_instruction'
  /** 工具返回值（**观测**，不是用户陈述） */
  | 'tool_output'
  /**
   * **已提交故事事件**（后 Lv2 · S1 / ADR-091 `D04`）。
   *
   * ⚠️ 它不是"另一种用户陈述"，也不是"另一种工具观测"：
   * 它表示这条内容来自**有限故事运行器已提交的事实**（模拟/剧情世界）。
   * 缺了它，剧情经历只能被塞进 `user_statement`（伪装成用户自述）
   * 或 `tool_output`（伪装成工具观测）—— 两者都正是 `observation.ts`
   * 开头那段注释点名要阻止的污染链。
   */
  | 'story_fact'

export const SOURCE_KINDS: readonly SourceKind[] = [
  'user_statement',
  'character_output',
  'system_instruction',
  'tool_output',
  'story_fact',
]

/**
 * `story_fact` **不是** `ActorType` 推出来的。
 *
 * ⚠️ 这条例外是**故意**的、也是必须的（ADR-091 `D04` 第 3 条硬约束）：
 * 故事来源**不是一种 actor** —— 没有一个"故事"主体在说话，
 * 有的是一次**已提交的世界事件**。因此：
 *   · `sourceKindForActor` 的签名与行为**一个字都没改**（它仍只接 `ActorType`）；
 *   · 故事来源必须由 `buildStoryProvenance()`（`src/kernel/storyline/**`）显式构造，
 *     并经 `assertRecordedAxisB` 校验；
 *   · 禁止把 `story_fact` 塞进 `SOURCE_KIND_BY_EVENT_FAMILY`（那是**对话事件族**的分类）。
 */
export const ACTOR_DERIVED_SOURCE_KINDS: readonly SourceKind[] = [
  'user_statement',
  'character_output',
  'system_instruction',
  'tool_output',
]

export function isActorDerivedSourceKind(kind: SourceKind): boolean {
  return (ACTOR_DERIVED_SOURCE_KINDS as readonly string[]).includes(kind)
}

/**
 * SourceKind ← ActorType 的映射 —— **M5.1.1 起降级为 legacy compatibility classifier**。
 *
 * ⚠️ 本函数的行为**一个字都没改**（阶段 1–3 不许改 Fact Firewall / 读路径行为）；
 *    改的是它的**契约定位**（ADR-042 §4 · 裁定 U-08）：
 *
 *   · **允许**：迁移分类器（给历史行定 `source_kind`）、`assertSourceConsistency`
 *     的一致性检查、旧读路径的兼容兜底
 *   · **禁止**：把它当作**新事件**的 authoritative 分类依据；尤其禁止把它扩成
 *     `PrincipalKind → SourceKind` 的**全函数**
 *
 * 为什么后者是禁止的：一个 total function 会让 Axis B 完全由 Axis A 决定，
 * 于是 `actor_type = 'user'` 一条就足以让内容变成"可支持外部事实"——
 * 这正是 `M5.1-D01` 的机制。新事件的 Axis B 必须**显式记录**
 * （`source_kind` / `source_authority` / `epistemic_source` 三列）。
 */
export function sourceKindForActor(actorType: ActorType): SourceKind {
  switch (actorType) {
    case 'user':
      return 'user_statement'
    case 'character':
      return 'character_output'
    case 'system':
      return 'system_instruction'
    case 'tool':
      return 'tool_output'
    default: {
      const exhaustive: never = actorType
      throw new KernelError(
        'validation_error',
        'unknown_actor_type',
        `未知的 actorType：${String(exhaustive)}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// SourceAuthority —— 这条内容**有资格**支持什么样的结论
// ---------------------------------------------------------------------------

/**
 * 计划书第 83 节。
 *
 * ⚠️ 这是**来源权威等级**，不是"最终认知状态"。
 * M3 只做标记；M4 才建立实际的 Memory Authority policy
 * （什么权威等级可以形成什么类型的记忆）。
 *
 * 因此这里的枚举刻意与"记忆类型"无关 —— 若现在就把
 * `USER_EXPLICIT → 可以建 preference memory` 写进代码，
 * 那就等于让 M3 提前替 M4 决定了信息语义（计划书第 130 节反对的正是这件事）。
 */
export type SourceAuthority =
  /** 用户明确陈述（"我特别喜欢猫"） */
  | 'USER_EXPLICIT'
  /** 用户在回复确认中给出的确认（"对，你说得没错"） */
  | 'USER_REPLY_CONFIRMATION'
  /** 直接互动本身构成的证据（她与用户之间**真实发生过**这一轮） */
  | 'DIRECT_INTERACTION'
  /** 工具的观测结果 */
  | 'TOOL_OBSERVATION'
  /** 她自己生成的内容（**默认不能升级成任何外部事实**） */
  | 'CHARACTER_GENERATION'
  /** 系统指令 / 系统通知 */
  | 'SYSTEM_INSTRUCTION'
  /**
   * **来源未确立**（M5.1.1 · ADR-042 §4 · 裁定 U-09）。
   *
   * 它不是"另一种权威等级"，而是**拒绝晋级**：这条内容的来源类别没有被确立。
   * 两条硬约束：
   *   · **不在** `EXTERNAL_FACT_AUTHORITIES` 白名单里（fail-closed：
   *     `canSupportExternalFact('UNCONFIRMED_ORIGIN') === false`）
   *   · **不得**被当作 `USER_EXPLICIT` 的等价物（ADR-042 §4：禁止伪造 `USER_EXPLICIT`）
   *
   * ⚠️ **且在 ADR-043 裁定之前它没有任何 MemoryAuthority 晋级路径**：
   *    `authorityFromSource('UNCONFIRMED_ORIGIN')` 刻意抛错（WP1.1，K-1 = B1）。
   *    它**可以**作为已记录的 provenance 存在（历史回填行必须记它），
   *    但"记录下来了"与"可以晋级成记忆权威"是两件事。
   */
  | 'UNCONFIRMED_ORIGIN'
  /**
   * **故事体验**（后 Lv2 · S1 / ADR-091 `D04`）。
   *
   * ⚠️ 它**不在** `EXTERNAL_FACT_AUTHORITIES` 白名单里（失败关闭）：
   *   `canSupportExternalFact('STORY_OBSERVATION') === false`
   * ⇒ "模拟中通过二面"**永远不能**升级成"用户现实中已被极创录取"。
   *
   * 它有资格支持的是**另一类**结论："她在这次故事体验里经历过这件事"。
   */
  | 'STORY_OBSERVATION'

export const SOURCE_AUTHORITIES: readonly SourceAuthority[] = [
  'USER_EXPLICIT',
  'USER_REPLY_CONFIRMATION',
  'DIRECT_INTERACTION',
  'TOOL_OBSERVATION',
  'CHARACTER_GENERATION',
  'SYSTEM_INSTRUCTION',
  'UNCONFIRMED_ORIGIN',
  'STORY_OBSERVATION',
]

/**
 * EpistemicSource —— 计划书第 29 节的"来源标签"。
 *
 * 与 `SourceAuthority` 的区别：authority 回答"能支持什么结论"，
 * epistemicSource 回答"这条内容属于哪一类认知产物"。
 *
 * ⚠️ **M5.1.1 收窄了"两者都由 SourceKind 推导"这句话**（ADR-042 §4 L568–572）：
 * 它现在只是**写入期**的性质，而且只对"来源已确立"（`attribution_origin = 'RECORDED'`）的行成立：
 *
 *     RECORDED         epistemic_source === epistemicSourceForKind(source_kind)  **必须**成立
 *     MIGRATED_LEGACY  epistemic_source = 'UNCONFIRMED_ORIGIN'，该等式**刻意不成立**
 *
 * 后者不是回归：把"没确立"重新说成"由 SourceKind 推导出来了"，
 * 正是 D01 的错误形状本身（把未知洗成确定）。
 */
export type EpistemicSource =
  | 'user_report'
  | 'character_generation'
  | 'system_instruction'
  | 'tool_observation'
  /**
   * **来源类别未确立**（M5.1.1 · ADR-042 §4 · 裁定 U-09，与
   * `SourceAuthority.UNCONFIRMED_ORIGIN` 成对出现）。
   *
   * ⚠️ **Axis B 没有 `Absent` 态**（ADR-042 §4 L549–554）：
   * 每条事件都有它的认知类别，所以这三个列在 `MIGRATED_LEGACY` 行上都是**具体受控值**，
   * 不用 NULL 语义，也不需要第二个 `unknown_reason`。
   */
  | 'UNCONFIRMED_ORIGIN'
  /**
   * **故事体验**（后 Lv2 · S1 / ADR-091 `D04`，与
   * `SourceAuthority.STORY_OBSERVATION` 成对出现）。
   *
   * ⚠️ **不**加进 `epistemicSourceForKind()` 的**actor 推导**路径之外的任何
   * "对话事件族"分类（`SOURCE_KIND_BY_EVENT_FAMILY` 一个字不改）。
   */
  | 'story_experience'

/** 受控词汇登记表（Axis B 的第二根轴；`story_experience` 是本工程新增的第 6 个值） */
export const EPISTEMIC_SOURCES: readonly EpistemicSource[] = [
  'user_report',
  'character_generation',
  'system_instruction',
  'tool_observation',
  'UNCONFIRMED_ORIGIN',
  'story_experience',
]

export function epistemicSourceForKind(kind: SourceKind): EpistemicSource {
  switch (kind) {
    case 'user_statement':
      return 'user_report'
    case 'character_output':
      return 'character_generation'
    case 'system_instruction':
      return 'system_instruction'
    case 'tool_output':
      return 'tool_observation'
    case 'story_fact':
      return 'story_experience'
  }
}

/**
 * 默认权威等级。
 *
 * 用户事件默认 `USER_EXPLICIT`；若它是对她某句话的**回复确认**，
 * 则由 `resolveAuthority()` 提升为 `USER_REPLY_CONFIRMATION`
 * ——这正是计划书第 33 节的关键：**权威来源是第二条 User Event，
 * 而不是第一条 Assistant Event**。
 */
export function defaultAuthorityForKind(kind: SourceKind): SourceAuthority {
  switch (kind) {
    case 'user_statement':
      return 'USER_EXPLICIT'
    case 'character_output':
      return 'CHARACTER_GENERATION'
    case 'system_instruction':
      return 'SYSTEM_INSTRUCTION'
    case 'tool_output':
      return 'TOOL_OBSERVATION'
    case 'story_fact':
      return 'STORY_OBSERVATION'
  }
}

// ---------------------------------------------------------------------------
// Assistant Fact Firewall
// ---------------------------------------------------------------------------

/**
 * 可以支持**外部事实**结论的权威等级。
 *
 * 这是一个**白名单**，不是黑名单：新增一种 authority 时它默认
 * **不能**支持外部事实，必须显式加进来。这样"某个新模块悄悄获得了
 * 制造事实的权力"不可能发生。
 *
 * ⚠️ `DIRECT_INTERACTION` **不在**里面：它支持的是"这一轮真实发生过"
 * 这个结论（对 Relationship / Affect 有用），而不是"某个关于世界的事实为真"。
 */
const EXTERNAL_FACT_AUTHORITIES: readonly SourceAuthority[] = [
  'USER_EXPLICIT',
  'USER_REPLY_CONFIRMATION',
  'TOOL_OBSERVATION',
]

/**
 * 计划书第 30/82 节：**任何 assistant_message 默认禁止自动升级成事实**。
 *
 * 这是 M3 最重要的一条纯函数。它的调用点**必须**是所有
 * "把对话内容提升为某种长期知识"的地方（M4 的 Memory Extractor 会是第一个），
 * 因此它住在契约层、由 kernel:test 直接守住。
 *
 * 注意它做的是**双向**判断：
 *   · `character_output` 永远不能支持外部事实
 *   · `system_instruction` 永远不能支持外部事实（第 84 节：系统提示
 *     "请以简洁方式回答"不能变成"苏沐薇记得有人曾要求自己简洁"）
 */
export function canSupportExternalFact(authority: SourceAuthority): boolean {
  return EXTERNAL_FACT_AUTHORITIES.includes(authority)
}

/** 这条来源是否属于"她自己生成的"（自述经历、自我虚构的来源） */
export function isCharacterGeneration(authority: SourceAuthority): boolean {
  return authority === 'CHARACTER_GENERATION'
}

/**
 * 计划书第 33 节：用户确认可以把证据等级提上去。
 *
 * 判定刻意做得**保守且可解释**：只有在"这条用户事件是在回复她那条
 * 生成内容"时才成立。不做语义判断，不做模型判断 ——
 * 那属于 M4，而且必须建立在 M3 已经正确的 reply graph 之上。
 */
export function resolveAuthority(input: {
  kind: SourceKind
  /** 该事件回复的那条事件（若存在） */
  repliedToKind?: SourceKind
}): SourceAuthority {
  const base = defaultAuthorityForKind(input.kind)
  if (input.kind === 'user_statement' && input.repliedToKind === 'character_output') {
    return 'USER_REPLY_CONFIRMATION'
  }
  return base
}

/**
 * 来源一致性检查（**失败关闭**）。
 *
 * 事件声明的 kind 必须与 actorType 推导出来的 kind 一致。
 * 这条检查看起来多余（因为我们自己写代码），但它拦住的是
 * "某个新模块传了一个手拼的 metadata"这类真实事故 ——
 * 一旦发生，账本里就永久留下了一条来源错误的事实（append-only，改不了）。
 */
export function assertSourceConsistency(input: {
  actorType: ActorType
  declaredKind: SourceKind | undefined
}): SourceKind {
  const derived = sourceKindForActor(input.actorType)
  if (input.declaredKind !== undefined && input.declaredKind !== derived) {
    throw new KernelError(
      'validation_error',
      'source_kind_actor_mismatch',
      `来源不一致：actorType=${input.actorType} 推导出 ${derived}，` +
        `但事件声明为 ${input.declaredKind}`
    )
  }
  return derived
}

// ---------------------------------------------------------------------------
// K-24 / R-21 —— RECORDED 的 Axis B 语义（**两分支**）
// ---------------------------------------------------------------------------

/**
 * `attribution_origin = RECORDED` 的含义**仅**是：
 *
 *     **attribution 是在事件发生当时被记录下来的。**
 *
 * 它**不**意味着"认知来源已经确立"。因此 RECORDED 行有两个**合法分支**：
 *
 *     confirmed   ：`source_authority !== UNCONFIRMED_ORIGIN`
 *                   ⇒ 必须满足 `epistemic_source === epistemicSourceForKind(source_kind)`
 *     unconfirmed ：认知资格**尚未确立** ⇒ `source_authority` 与 `epistemic_source`
 *                   **必须同时**是 `UNCONFIRMED_ORIGIN`（成对出现，不许只写一个）
 *
 * ⚠️ 本契约原来隐含地只承认 confirmed 分支（`buildProvenance` 无条件写
 *    `epistemicSourceForKind(kind)`），于是"agent 以 user 身份提交、认知资格未确立"
 *    这类**真实**行在写入期**表达不出来** —— 那就是 K-24 的 representability gap。
 */
export const UNCONFIRMED_AXIS_B_VALUE = 'UNCONFIRMED_ORIGIN' as const

/**
 * **事件族** → `SourceKind`（R-21 §2 的冻结分类）。
 *
 * ⚠️ 这是**事件族分类**，**不是** `PrincipalKind → SourceKind`：
 *     · `SERVICE` **不得**自动意味着 `system_instruction`
 *     · `EXTERNAL_ACTOR` **不得**推出任何 `SourceKind`
 *     · `actor_type='user'` **不得**自动意味着 `USER_EXPLICIT`
 * 契约里**没有**（也不得有）`sourceKindForPrincipalKind` 这类函数；
 * K-24 门会静态断言这一点。
 */
export const SOURCE_KIND_BY_EVENT_FAMILY: Readonly<
  Record<'user_message' | 'assistant_message' | 'system_event' | 'tool_event', SourceKind>
> = {
  user_message: 'user_statement',
  assistant_message: 'character_output',
  system_event: 'system_instruction',
  tool_event: 'tool_output',
}

export function sourceKindForEventFamily(
  family: keyof typeof SOURCE_KIND_BY_EVENT_FAMILY
): SourceKind {
  return SOURCE_KIND_BY_EVENT_FAMILY[family]
}

export type RecordedAxisBBranch = 'confirmed' | 'unconfirmed'

export type RecordedAxisBVerdict =
  | { ok: true; branch: RecordedAxisBBranch }
  | {
      ok: false
      code: 'axis_b_unconfirmed_branch_incomplete' | 'axis_b_confirmed_branch_epistemic_mismatch'
      detail: string
    }

/**
 * RECORDED 行的 Axis B 判定（纯函数，**两分支**）。
 *
 * 两条**必须拒**的混合形态（R-21 §6）：
 *   · `source_authority = UNCONFIRMED_ORIGIN` 而 `epistemic_source` 不是 ⇒ 拒
 *   · `source_authority` 已确立而 `epistemic_source = UNCONFIRMED_ORIGIN` ⇒ 拒
 */
export function classifyRecordedAxisB(input: {
  sourceKind: SourceKind
  sourceAuthority: SourceAuthority
  epistemicSource: EpistemicSource
}): RecordedAxisBVerdict {
  const authorityUnconfirmed = input.sourceAuthority === UNCONFIRMED_AXIS_B_VALUE
  const epistemicUnconfirmed = input.epistemicSource === UNCONFIRMED_AXIS_B_VALUE

  if (authorityUnconfirmed || epistemicUnconfirmed) {
    if (authorityUnconfirmed && epistemicUnconfirmed) return { ok: true, branch: 'unconfirmed' }
    return {
      ok: false,
      code: 'axis_b_unconfirmed_branch_incomplete',
      detail:
        'unconfirmed 分支要求 source_authority 与 epistemic_source **同时**是 ' +
        `UNCONFIRMED_ORIGIN（实际：authority=${input.sourceAuthority} / ` +
        `epistemic=${input.epistemicSource}）—— 只写一个是不可表达的中间态`,
    }
  }

  const expected = epistemicSourceForKind(input.sourceKind)
  if (input.epistemicSource !== expected) {
    return {
      ok: false,
      code: 'axis_b_confirmed_branch_epistemic_mismatch',
      detail:
        `confirmed 分支要求 epistemic_source === epistemicSourceForKind(${input.sourceKind}) ` +
        `= ${expected}（实际：${input.epistemicSource}）`,
    }
  }
  return { ok: true, branch: 'confirmed' }
}

/** 失败关闭版本 */
export function assertRecordedAxisB(input: {
  sourceKind: SourceKind
  sourceAuthority: SourceAuthority
  epistemicSource: EpistemicSource
}): RecordedAxisBBranch {
  const verdict = classifyRecordedAxisB(input)
  if (!verdict.ok) {
    throw new KernelError('validation_error', verdict.code, verdict.detail)
  }
  return verdict.branch
}

/**
 * 一整套 provenance 标签（计划书第 26 节的至少 7 项里的领域侧部分）。
 *
 * 领域侧只负责"谁 / 什么类别 / 什么权威 / 哪一类认知产物"；
 * `eventId` / `conversationId` / `timestamp` / `transport` 由事件本身与
 * 基础设施补齐（它们不是领域概念）。
 */
export interface SourceProvenance {
  kind: SourceKind
  authority: SourceAuthority
  epistemicSource: EpistemicSource
  /** 具体说话人（UserId / CharacterId / 系统组件名 / 工具名） */
  actorId: string
  actorType: ActorType
  /** 回复哪条事件（reply graph，计划书第 34 节） */
  replyToEventId?: string
  /** 渠道来源（cli / qq / discord / harness…）。**不参与人格逻辑**（第 25 节） */
  transport?: string
}

/** 由 actor + 可选 reply 上下文构造完整 provenance */
export function buildProvenance(input: {
  actorType: ActorType
  actorId: string
  declaredKind?: SourceKind
  repliedToKind?: SourceKind
  replyToEventId?: string
  transport?: string
}): SourceProvenance {
  const kind = assertSourceConsistency({
    actorType: input.actorType,
    declaredKind: input.declaredKind,
  })
  return {
    kind,
    authority: resolveAuthority({ kind, repliedToKind: input.repliedToKind }),
    epistemicSource: epistemicSourceForKind(kind),
    actorId: input.actorId,
    actorType: input.actorType,
    ...(input.replyToEventId ? { replyToEventId: input.replyToEventId } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
  }
}

// ---------------------------------------------------------------------------
// 故事来源（后 Lv2 · S1 / ADR-091 D04–D07）
// ---------------------------------------------------------------------------

/** 故事来源的**世界侧**身份（`story:<id>@v<n>#<run>.<event>` 由 kernel/storyline 构造） */
export interface StorySourceIdentity {
  /** 确定性来源 id（进 `EvidenceRef.id` 的字符串侧） */
  storySourceId: string
  /** 故事来源是**亲历**还是**用户转述**（契约 S10：来源追问必须能区分） */
  experienceScope: 'story_experience' | 'user_report'
}

// ---------------------------------------------------------------------------
// 故事来源 id 的**语法**（后 Lv2 · S8 / WP3：从 `kernel/storyline/story-types.ts` 上移）
// ---------------------------------------------------------------------------

/**
 * 从来源 id 取回的四个分量。
 *
 * ⚠️ **为什么这条语法住在契约层而不是世界实现里**：它进 `EvidenceRef.id`，
 * 凡是要核对"这条引用读的是哪一版剧情"的只读适配器都要用它 ——
 * 而那些适配器大多**不在**世界实现的白名单目录里（FC-T04 的模块边界锁会当场拦下
 * `import .../storyline/`）。把语法放在契约层，世界实现反过来引用它，边界才是干净的。
 */
export interface StorySourceIdParts {
  storyId: string
  storyVersion: number
  runId: string
  eventId: string
}

/** 形如 `story:<storyId>@v<version>#<runId>.<eventId>`（确定性） */
export function makeStorySourceId(input: StorySourceIdParts): string {
  assertStoryIdSlug(input.storyId, 'storyId')
  assertStoryIdSlug(input.runId, 'runId')
  assertStoryIdSlug(input.eventId, 'eventId')
  if (!Number.isSafeInteger(input.storyVersion) || input.storyVersion < 1) {
    throw new KernelError(
      'validation_error',
      'bad_story_version',
      `storyVersion 必须是 >= 1 的安全整数，收到 ${String(input.storyVersion)}`
    )
  }
  return `story:${input.storyId}@v${input.storyVersion}#${input.runId}.${input.eventId}`
}

export function parseStorySourceId(value: string): StorySourceIdParts | undefined {
  const match = /^story:([A-Za-z0-9_-]{1,60})@v(\d{1,6})#([A-Za-z0-9_-]{1,60})\.([A-Za-z0-9_-]{1,60})$/.exec(
    value
  )
  if (!match) return undefined
  return {
    storyId: match[1]!,
    storyVersion: Number(match[2]),
    runId: match[3]!,
    eventId: match[4]!,
  }
}

export function isStorySourceId(value: unknown): value is string {
  return typeof value === 'string' && parseStorySourceId(value) !== undefined
}

/**
 * **S8 / ADR-093 `D03`**：提案与内部事件携带的**故事来源引用**。
 *
 * ⚠️ 它与 `sourceConversationEventIds` **并列而不是合并**：
 * 后者永远只指对话事件（`S8-A05`）。把故事引用塞进对话数组 = 让"她听用户说的"
 * 与"她自己经历的"在**因果引用**这一层就分不开。
 *
 * ⚠️ 生产端只有**一处**能构造它：账本读取口（`findStoryEvents`）——
 * 调用方不得自由拼（否则就出现"模型声明这是哪一次经历"）。
 */
export interface StorySourceRef {
  /** 确定性来源 id（观测或提交身份；`parseStorySourceId` 必须能解析） */
  sourceId: string
  storyId: string
  storyVersion: number
  runId: string
  eventId: string
  /** 亲历 vs 用户转述（契约 S10：来源追问必须能区分） */
  experienceScope: StorySourceIdentity['experienceScope']
}

/**
 * 构造一条故事来源引用（**读回自检**：四个分量必须与 `sourceId` 逐字一致）。
 *
 * 先例：`assertStoryProvenanceReadback`（`kernel/storyline/world-machine.ts`）。
 * 少了这一步，引用的字符串与结构字段可以各说各话 —— 而"这条记忆读的是哪一次经历"
 * 恰恰只能靠它们一致来回答。
 */
export function storySourceRefOf(input: {
  sourceId: string
  experienceScope: StorySourceIdentity['experienceScope']
}): StorySourceRef {
  const parts = parseStorySourceId(input.sourceId)
  if (!parts) {
    throw new KernelError(
      'validation_error',
      'bad_story_source_id',
      `故事来源引用不可解析：${JSON.stringify(input.sourceId)}`
    )
  }
  if (input.experienceScope !== 'story_experience' && input.experienceScope !== 'user_report') {
    throw new KernelError(
      'validation_error',
      'bad_story_experience_scope',
      `experienceScope 必须是 story_experience / user_report，收到 ${JSON.stringify(input.experienceScope)}`
    )
  }
  return {
    sourceId: input.sourceId,
    storyId: parts.storyId,
    storyVersion: parts.storyVersion,
    runId: parts.runId,
    eventId: parts.eventId,
    experienceScope: input.experienceScope,
  }
}

function assertStoryIdSlug(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(value)) {
    throw new KernelError(
      'validation_error',
      'bad_story_slug',
      `${label} 只允许字母数字与 _ -（长度 1..60），收到 ${JSON.stringify(value)}：` +
        '来源身份要能一眼读懂，不能靠转义'
    )
  }
}

/**
 * 由**已提交故事事件**构造 provenance。
 *
 * ⚠️ 与 `buildProvenance()` 分开是**故意**的，而且这条分叉是 ADR-091 `D04` 的硬约束：
 * 故事来源**不是一种 actor**（没有一个"故事"主体在说话），因此它**不能**走
 * `assertSourceConsistency`（那个函数的输入域是 `ActorType`，多一个 `STORY` actor
 * 会把 "谁是说话人" 这条既有的四值封闭分类弄松）。
 *
 * 它**仍然**接受同一条失败关闭：三列必须由 `assertRecordedAxisB` 校验，
 * 且 `STORY_OBSERVATION` 不在外部事实白名单里（`canSupportExternalFact` = false）。
 */
export function buildStoryProvenance(
  story: StorySourceIdentity
): Omit<SourceProvenance, 'actorType'> & { storySourceId: string; experienceScope: StorySourceIdentity['experienceScope'] } {
  if (story.storySourceId.trim() === '') {
    throw new KernelError(
      'validation_error',
      'story_source_without_identity',
      '故事来源必须带确定性来源 id：没有来源的观测无法回答"她是听谁说的/在哪经历的"'
    )
  }
  return {
    kind: 'story_fact',
    authority: 'STORY_OBSERVATION',
    epistemicSource: 'story_experience',
    actorId: story.storySourceId,
    storySourceId: story.storySourceId,
    experienceScope: story.experienceScope,
  }
}

/**
 * 故事来源的**失败关闭**自检（ADR-091 `D04` 第 1 条）。
 *
 * 它是纯函数、可被门直接调用：`STORY_OBSERVATION` 一旦被加进外部事实白名单，
 * 这条就会失败 —— 那正是"模拟中通过二面不能升级成现实录取"的机器形态。
 */
export function assertStorySourceIsNotExternalFact(): void {
  if (canSupportExternalFact('STORY_OBSERVATION')) {
    throw new KernelError(
      'validation_error',
      'story_observation_is_external_fact',
      'STORY_OBSERVATION 出现在 EXTERNAL_FACT_AUTHORITIES 白名单里：' +
        '这会让"模拟中通过二面"升级成"用户现实中已被极创录取"（ADR-091 D04 第 1 条）'
    )
  }
  if (canSupportExternalFact('CHARACTER_GENERATION')) {
    throw new KernelError('validation_error', 'character_generation_is_external_fact', '自造内容不得支持外部事实')
  }
}
