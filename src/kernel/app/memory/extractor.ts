/**
 * MemoryExtractor —— **后台抽取：从真实对话里发现值得长期记住的事**
 * （计划书第 42–47、63–69、123–127 节）。
 *
 * ============================================================================
 *  这是"两速记忆"里慢的那一条
 * ============================================================================
 * 计划书第 61 节：
 *
 *               Memory
 *              /      \
 *    Explicit Path    Background Path
 *         │                 │
 *       fast             async
 *         │                 │
 *   用户要求记住       自动发现重要经历
 *
 * 它**不是** best-effort 的附属品，但它与显式路径有三条硬区别：
 *
 *   1. **异步**：跑在 Job 里，失败不影响已经完成的聊天（计划书第 63 节）
 *   2. **可以 REJECT**：大量普通对话根本不值得长期记（计划书第 50 节）
 *   3. **必须自己证明证据**：用户没有指定"记哪一句"，因此
 *      "这条记忆来自哪"完全由抽取器与 Source Firewall 决定
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 三条不许破的规矩（每一条都对应一个真实的污染路径）
 * ---------------------------------------------------------------------------
 * **规矩 1：Prompt 必须显式带 Actor（计划书第 125 节）**
 *
 *     否则模型很容易把角色自己的话归到用户头上。
 *
 * **规矩 2：模型的输出必须带证据序号（计划书第 126 节）**
 *
 *     如果 Evidence 不存在 → Validator Reject。
 *
 * **规矩 3：权威等级不许由模型自述（本文件最重要的一条）**
 *
 * 模型想写什么 authority 就写什么 authority 的话，它只要输出
 * `EXPLICIT_USER_STATEMENT` 就能把**她自己的猜测**变成关于用户的
 * 长期事实 —— 那正是计划书第 148 节的污染链。
 * 因此 `authority` **一律由证据事件自己的来源推导**，
 * 模型在 JSON 里写的任何 authority 字段都被**忽略**
 * （`parseOneDescriptor` 压根不读它）。
 */

import {
  KernelError,
  authorityFromSource,
  authorityRank,
  canEvidenceExternalFact,
  createMemoryCandidate,
  defaultAuthorityForKind,
  isMemoryType,
  registeredPredicates,
  sourceKindForActor,
  type ConversationEvent,
  type EntityRef,
  type EvidenceRef,
  type MemoryAuthority,
  type MemoryCandidate,
  type MemoryEpistemicStatus,
  type MemoryType,
  type ClaimMemoryContent,
  type EpisodicMemoryContent,
} from '../../contracts/index.ts'
import type { ProcessorContext, ProcessorEventView } from '../../contracts/processor.ts'
import { isQuestionLike } from './content-extractor.ts'
import {
  COGNITIVE_QUALIFICATION_RULE_VERSION,
  EVIDENCE_ORIGIN_CONTRADICTS_CLAIM,
  EVIDENCE_ORIGIN_NOT_ESTABLISHED,
  qualificationEstablishesUserFact,
  sourceQualificationOf,
  trustedOriginReadingOf,
} from '../../contracts/attribution.ts'

export const MEMORY_EXTRACTOR_NAME = 'memory-extractor'
export const MEMORY_EXTRACTOR_VERSION = 'memory-extractor@1'

// ---------------------------------------------------------------------------
// ConversationEvent → ProcessorEventView（计划书第 124 节的输入边界）
// ---------------------------------------------------------------------------

/**
 * 计划书第 124 节：
 *
 *     必须是 ConversationEvent / Observation refs
 *     不能只给模型"一段没有来源标签的文本"
 *
 * 这个函数就是那条约束的落地点：抽取器的输入**只有**这个视图，
 * 它看不到数据库行、看不到 `metadata`、也拿不到无来源的裸文本。
 *
 * ⚠️ 工具事件**失败关闭**。`ProcessorEventView.actorType` 只有三种
 * （user / character / system），而 `ConversationEvent` 有四种（多一个 tool）。
 * 把 tool 冒充成 character 或 system 正是 `tool_event` 这个枚举要阻止的
 * 伪装通道；而计划书第 154 节要求 Tool Observation 与用户陈述**隔离**，
 * M4 不主动发展这类来源。
 */
export function processorEventViewOf(event: ConversationEvent): ProcessorEventView {
  if (event.actorType === 'tool') {
    throw new KernelError(
      'validation_error',
      'tool_event_not_extractable_in_m4',
      `tool_event（${String(event.id)}）不能被 M4 的抽取器处理：` +
        '把它冒充成 character 或 system 会污染来源语义，而来源一旦写错就改不回来。' +
        '计划书第 154 节要求 Tool Observation 与用户陈述隔离，M4 不主动发展这类来源',
      { eventId: String(event.id) }
    )
  }

  const type: ProcessorEventView['type'] =
    event.type === 'user_message' ||
    event.type === 'assistant_message' ||
    event.type === 'system_event'
      ? event.type
      : 'system_event'

  /*
   * M5.1.1 / Phase 4a（ADR-043 `DR-6`）：**受信**来源读数。
   *
   * 只有 `attribution_origin = 'RECORDED'` 的行才配得上它 —— 那种行只可能由
   * `buildTrustedAttributionContext()` 产出的上下文写出来。MIGRATED_LEGACY 与
   * "没有信封"都**不**产生读数 ⇒ 下游一律判为"来源未确立"（`DR-7`，失败关闭）。
   *
   * ⚠️ 本函数是**唯一**的生产产出点（4a 专项门会静态断言这一点）。
   */
  const trustedOrigin = trustedOriginReadingOf({
    attributionOrigin: event.attribution?.attributionOrigin,
    contentOriginator: event.attribution?.slots?.contentOriginator,
    axisB: {
      sourceKind: event.sourceKind,
      sourceAuthority: event.sourceAuthority,
      epistemicSource: event.epistemicSource,
    },
  })

  return {
    id: event.id,
    sequence: event.sequence,
    conversationSequence: event.conversationSequence,
    type,
    actorType: event.actorType,
    ...(event.actorId !== undefined ? { actorId: event.actorId } : {}),
    content: event.content,
    createdAt: event.createdAt,
    // M9 WP3 追加（可选字段；B-INFERRED 的跨会话判据需要会话维度）
    conversationId: event.conversationId,
    ...(trustedOrigin !== undefined ? { trustedOrigin } : {}),
  }
}

// ---------------------------------------------------------------------------
// 来源推导（Source Firewall 的输入）
// ---------------------------------------------------------------------------

/** 一个事件在本批次里的来源画像（权威**不来自模型**） */
export interface EvidenceProfile {
  /** 该事件可支持的最高来源权威（已映射成 `MemoryAuthority`） */
  authority: MemoryAuthority
  /** 该事件是否可作为**外部事实**的证据（`canEvidenceExternalFact`） */
  canSupportExternalFact: boolean
  /** 该事件是否属于"真实发生过的一次互动" */
  isDirectInteraction: boolean
}

/**
 * 从事件视图推导来源画像。
 *
 * `ProcessorEventView` 只有 `actorType`，没有 M3 的结构化 provenance 列，
 * 因此这里用 `sourceKindForActor` + `defaultAuthorityForKind` 推导 ——
 * 与 `deriveSourceForLegacyRow()` 是同一套规则。
 *
 * ⚠️ 一个刻意的取舍：这一层**看不见** `USER_REPLY_CONFIRMATION`
 * （视图不带 `sourceAuthority`），于是"用户回复确认"被降成
 * `EXPLICIT_USER_STATEMENT`。这个降级是**安全的** ——
 * 两者在 `authorityFromSource` 里映射到**同一个** `MemoryAuthority`
 * （审计 §4 D1：对用户个人事实而言两者证据强度同级）。
 */
export function evidenceProfileOf(view: ProcessorEventView): EvidenceProfile {
  const sourceAuthority = defaultAuthorityForKind(sourceKindForActor(view.actorType))
  return {    authority: authorityFromSource(sourceAuthority),
    canSupportExternalFact: canEvidenceExternalFact({
      type: view.type,
      actorType: view.actorType,
      sourceAuthority,
    }),
    isDirectInteraction: view.actorType === 'user' || view.actorType === 'character',
  }
}

/**
 * 在多个证据里取**最高**的权威。
 *
 * 为什么取最高而不是最低：一条记忆常由多条事件共同支持
 * （"他先说 X，我追问，他确认 X"）。取最低会让一次追问把整条记忆的
 * 权威拉到追问那条的水平上 —— 而追问通常也是用户陈述，所以取最高
 * 不会造成越权；取最低却会让合法记忆被无谓地拒绝。
 *
 * ⚠️ 上界仍由证据本身决定：全是 character 事件时最高只能是
 * `CHARACTER_GENERATION` —— 那仍然建不了用户事实。因此取最高
 * **不会**削弱 Source Firewall。
 */
export function highestAuthorityOf(profiles: readonly EvidenceProfile[]): MemoryAuthority {
  if (profiles.length === 0) {
    throw new KernelError(
      'validation_error',
      'no_evidence_profiles',
      '没有任何证据画像：没有来源的记忆不允许被构造（MI-03）'
    )
  }
  return [...profiles].sort((a, b) => authorityRank(a.authority) - authorityRank(b.authority))[0]
    .authority
}

/** "关于用户个人的事实"需要外部事实证据（计划书第 27 节） */
function needsExternalFactEvidence(type: MemoryType): boolean {
  return type === 'person_fact' || type === 'preference'
}

/** Claim 家族 vs Episode 家族（与 `memory.ts` 的划分**同一套语义**） */
function isClaimType(type: MemoryType): boolean {
  return type === 'person_fact' || type === 'preference'
}

// ---------------------------------------------------------------------------
// 候选描述（抽取器产出的**中间**形状）
// ---------------------------------------------------------------------------

/**
 * 抽取器产出的候选描述。
 *
 * ⚠️ 它**不是** `MemoryCandidate`：这里的 `subjectToken` 是**角色令牌**
 * （`'USER'` / `'CHARACTER'`）而不是 `EntityRef` —— 模型不该知道用户的 id
 * （那是基础设施的事）。`resolveCandidates()` 负责换令牌、推权威。
 *
 * 同样地，`evidenceEventSequences` 是**序号**而不是事件 id：
 * 模型看到的 prompt 里写的就是 `Event 42`，让它复述 id 只会给它一个
 * 编造 id 的机会。
 *
 * ⚠️ **刻意没有 `authority` 字段**。这不是遗漏：让模型能填 authority
 * 就等于让它自己决定"我的话算不算事实"。字段不存在 → 它写不进来。
 */
export interface CandidateDescriptor {
  memoryType: MemoryType
  subjectToken: 'USER' | 'CHARACTER'
  claim?: {
    predicate: string
    value: unknown
    qualifiers?: Record<string, unknown>
  }
  episode?: {
    summary: string
    participantTokens: ('USER' | 'CHARACTER')[]
    topicTags?: string[]
  }
  /** 本批次内的事件序号。**必须非空**（计划书第 126 节） */
  evidenceEventSequences: number[]
  /** 事实发生的时间（可选） */
  occurredAt?: number
  /** 模型自评的"值得长期记住的程度"（0..1）。由 Value Gate 使用与校正 */
  longTermValue?: number
  /** 模型自评的置信度（0..1） */
  confidence?: number
}

export interface ResolveContext {
  owner: EntityRef
  /** 本批次的事件（渲染 prompt 时用的就是它们） */
  events: readonly ProcessorEventView[]
  /** `USER` 令牌对应的 `EntityRef`（由装配层给出，抽取器不认识 id） */
  speaker: EntityRef
  processor: string
  processorVersion: string
}

/**
 * 一次解析的产物。
 *
 * ⚠️ 判别联合，不是"`candidate` 可能为 undefined 而 `rejected` 可能为空"
 * 那种两个字段各自可空、组合起来有四种状态的形状。
 *
 * 第一版就写成了后者（用 `candidate: undefined as never` 糊过类型检查），
 * 而那意味着"这条通过了吗"要靠读代码判断。联合让"通过 ⇔ 有候选"成为
 * 类型层面的事实 —— 与 `ExplicitMemoryOutcome` 用同一个手法。
 */
export type ResolvedCandidate =
  | { ok: true; candidate: MemoryCandidate }
  | { ok: false; rejection: { reason: string; detail: string } }

const reject = (reason: string, detail: string): ResolvedCandidate => ({
  ok: false,
  rejection: { reason, detail },
})

/**
 * 把候选描述解析成真正的 `MemoryCandidate`。
 *
 * ============================================================================
 *  Source Firewall 在这里（计划书第 126 / 148 / 149 / 154 节）
 * ============================================================================
 * 六道闸，逐条对应一个真实的污染路径：
 *
 *   1. 类型必须已登记
 *   2. **证据序号必须存在**（第 126 节）：引用不存在的序号 → 丢
 *   3. **权威由证据推导，不由模型自述**（第 148 节）
 *   4. **事实类必须有可支持外部事实的证据**（`canEvidenceExternalFact`）
 *   5. **经历类必须有直接互动的证据**（第 149 节）
 *   6. 交给 `createMemoryCandidate` 的三条契约断言（内容/类型、权威、证据）
 *
 * M5.1.1 / Phase 4a（ADR-043 `DR-1` / `DR-6` / `DR-7`）在**闸 2 与闸 3 之间**
 * 追加了一道**来源资格闸**（`SourceQualification`）：事实类候选只有在证据的来源
 * **已确立**时才能继续。它在权威推导**之前**，因为 `authorityFromSource` 对
 * `UNCONFIRMED_ORIGIN` 是**抛错**而不是干净拒绝 ——
 * 让未确立的来源走到那里会变成 500 而不是一条可读的拒绝理由。
 * 它**不改**闸 3 / 闸 4 的判据，只把"来源都不知道从哪来"挡在前面。
 *
 * ⚠️ 上面这段（以及本文件其它新增注释）刻意**不写**那段推导函数的调用形状
 *    （函数名后面**不接左括号**）：`m5.1.1:k17:verify` 用"函数名 + 左括号"的字面计数
 *    断言"src/ 里只有一处真的在用它算记忆权威"，而它**不剥注释**
 *    ⇒ 注释里写出调用形状会**假红**那条断言。
 *    第一版踩了两次（计数 1 → 3，再到 2，多的每一处都是注释，包括这一段的上一版）。
 */
export function resolveCandidates(
  descriptors: readonly CandidateDescriptor[],
  context: ResolveContext
): ResolvedCandidate[] {
  const bySequence = new Map(context.events.map((e) => [e.sequence, e]))

  return descriptors.map((descriptor) => resolveOne(descriptor, context, bySequence))
}

function resolveOne(
  descriptor: CandidateDescriptor,
  context: ResolveContext,
  bySequence: Map<number, ProcessorEventView>
): ResolvedCandidate {
  // ---- 闸 1：类型必须已登记 ---------------------------------------------
  if (!isMemoryType(descriptor.memoryType)) {
    return reject('unknown_memory_type', `未登记的 memoryType：${String(descriptor.memoryType)}`)
  }
  const type = descriptor.memoryType

  // ---- 闸 2：证据序号必须真实存在（计划书第 126 节）--------------------
  if (
    !Array.isArray(descriptor.evidenceEventSequences) ||
    descriptor.evidenceEventSequences.length === 0
  ) {
    return reject('evidence_missing', '候选没有引用任何证据事件（计划书第 126 节）')
  }

  const evidenceViews: ProcessorEventView[] = []
  const missing: number[] = []
  for (const sequence of descriptor.evidenceEventSequences) {
    const view = bySequence.get(sequence)
    if (view === undefined) missing.push(sequence)
    else evidenceViews.push(view)
  }
  if (missing.length > 0) {
    // **不猜、不就近取**：引用不存在的证据是模型在编造来源，
    // 而"来源是编的"与"来源是错的"一样不可接受。
    return reject(
      'evidence_sequence_not_in_batch',
      `候选引用了本批次不存在的证据序号：${missing.join(', ')}。不就近取、不忽略`
    )
  }

  // ---- 闸 2.5：来源必须已确立（M5.1.1 / Phase 4a；ADR-043 DR-1/DR-6/DR-7）--
  //
  // 位置是**刻意**的：它必须在闸 3（权威推导）**之前**。
  // 权威推导对 `UNCONFIRMED_ORIGIN` 是**抛错**，不是干净拒绝；
  // 让"来源不知道从哪来"的证据走到那里，会把一条可读的拒绝变成 500。
  //
  // 它**只**给"关于用户个人的事实"（`person_fact` / `preference`）加条件 ——
  // 与闸 4 的射程**完全一致**（`needsExternalFactEvidence`）。经历类不受影响。
  //
  // `DR-6`：只有**受信**归因算数。`trustedOrigin` 是 `processorEventViewOf()`
  // 从 `attribution_origin = 'RECORDED'` 且 Axis B 落在 confirmed 分支的行上取的；
  // 调用方自报的 provenance **不参与**这个判定（那个字段压根不在 `ProcessorEventView` 上）。
  // `DR-7`：没有读数 = 来源未确立，**失败关闭**，没有时间豁免。
  if (needsExternalFactEvidence(type)) {
    const qualifications = evidenceViews.map((view) => sourceQualificationOf(view.trustedOrigin))
    if (!qualifications.some(qualificationEstablishesUserFact)) {
      // 三值里"知道不是他"比"不知道"更具体，因此优先报前者（`DR-3` 不合并的理由）。
      const contradicted = qualifications.includes('CONTRADICTED_ORIGIN')
      return reject(
        contradicted ? EVIDENCE_ORIGIN_CONTRADICTS_CLAIM : EVIDENCE_ORIGIN_NOT_ESTABLISHED,
        `${type} 需要"来源已确立"的证据（ADR-043 ${contradicted ? 'DR-3 / DR-6' : 'DR-7'}，` +
          `规则版本 ${COGNITIVE_QUALIFICATION_RULE_VERSION}），而这批证据的来源` +
          (contradicted
            ? '**已确立但不是人类** —— 内容作者不是用户，却要写成关于用户的长期事实'
            : '**没有确立**（没有受信归因信封，或 Axis B 不完整）') +
          '。这正是计划书第 148 节的污染路径：来源不知道从哪来，就不能成为事实。'
      )
    }
  }

  // ---- 闸 3：权威由证据推导（**不使用模型自述的 authority**）-----------
  const profiles = evidenceViews.map(evidenceProfileOf)
  const authority = highestAuthorityOf(profiles)

  // ---- 闸 4 / 5：证据必须真的能支持这一类结论 -------------------------
  if (needsExternalFactEvidence(type) && !profiles.some((p) => p.canSupportExternalFact)) {
    return reject(
      'evidence_cannot_support_external_fact',
      `${type} 需要"可支持外部事实"的证据，而这批证据全部来自她自己或系统` +
        `（最高权威 ${authority}）。这正是计划书第 148 节的污染路径：` +
        '她自己的输出不能成为关于用户的长期事实'
    )
  }
  if (!isClaimType(type) && !profiles.some((p) => p.isDirectInteraction)) {
    return reject(
      'evidence_cannot_support_episode',
      `${type} 需要"真实发生过"的证据（计划书第 149 节），而这批证据里没有互动方`
    )
  }

  // ---- 令牌 → EntityRef -------------------------------------------------
  const refs = subjectRefsOf(descriptor, context)
  if (refs === undefined) {
    return reject('unknown_subject_token', `未知的 subjectToken：${String(descriptor.subjectToken)}`)
  }

  // ---- 构造内容 --------------------------------------------------------
  let content: ClaimMemoryContent | EpisodicMemoryContent
  if (isClaimType(type)) {
    if (descriptor.claim === undefined) {
      return reject('claim_content_missing', `${type} 是 Claim 家族，但没有 claim 字段`)
    }
    content = {
      kind: 'claim',
      subject: refs.subject,
      predicate: descriptor.claim.predicate,
      value: descriptor.claim.value,
      ...(descriptor.claim.qualifiers !== undefined
        ? { qualifiers: descriptor.claim.qualifiers }
        : {}),
    }
  } else {
    if (descriptor.episode === undefined) {
      return reject('episode_content_missing', `${type} 是 Episode 家族，但没有 episode 字段`)
    }
    content = {
      kind: 'episode',
      summary: descriptor.episode.summary,
      participants: refs.participants,
      eventRefs: evidenceViews.map((view) => String(view.id)),
      ...(descriptor.episode.topicTags !== undefined
        ? { topicTags: descriptor.episode.topicTags }
        : {}),
    }
  }

  // ---- 闸 6：交给契约断言 ----------------------------------------------
  try {
    const candidate = createMemoryCandidate({
      owner: context.owner,
      type,
      content,
      subjects: refs.all,
      sourceRefs: evidenceViews.map(
        (view): EvidenceRef => ({ kind: 'conversation_event', id: String(view.id) })
      ),
      evidenceRootIds: evidenceViews.map((view) => String(view.id)),
      epistemicStatus: epistemicStatusFor(type, profiles),
      authority,
      /*
       * importance / confidence 先填**中性值**，由 Value Gate 重算。
       * 刻意不在这里就填模型自评值：那会让"值不值得记"与"抽取是否可信"
       * 混在一起，而计划书第 52 节要求两者分开（`confidence ≠ importance`）。
       */
      importance: 0.5,
      confidence: clamp01(descriptor.confidence ?? 0.6),
      ...(descriptor.occurredAt !== undefined ? { proposedOccurredAt: descriptor.occurredAt } : {}),
      processor: context.processor,
      processorVersion: context.processorVersion,
    })
    return { ok: true, candidate }
  } catch (error) {
    return reject(
      'contract_assertion_failed',
      `${(error as { code?: string }).code ?? 'error'}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function subjectRefsOf(
  descriptor: CandidateDescriptor,
  context: ResolveContext
): { subject: EntityRef; participants: EntityRef[]; all: EntityRef[] } | undefined {
  const toRef = (token: 'USER' | 'CHARACTER'): EntityRef =>
    token === 'USER' ? context.speaker : context.owner

  const subject = toRef(descriptor.subjectToken)

  if (isClaimType(descriptor.memoryType)) {
    // Claim：subjects 必须与 `content.subject` 一致
    // （`validateClaimContent` 会校验，不一致就抛 —— 这里就让它一致）
    return { subject, participants: [subject], all: [subject] }
  }

  const tokens = descriptor.episode?.participantTokens ?? [descriptor.subjectToken]
  const participants: EntityRef[] = []
  for (const token of tokens) {
    const ref = toRef(token)
    if (!participants.some((p) => p.kind === ref.kind && String(p.id) === String(ref.id))) {
      participants.push(ref)
    }
  }
  // Episode 至少一个参与者（`validateEpisodicContent` 要求）
  if (participants.length === 0) participants.push(subject)
  return { subject, participants, all: participants }
}

/**
 * 认知状态。
 *
 * 计划书第 22 节：`REPORTED` / `OBSERVED` / `INFERRED` / `GENERATED`。
 * M4 的抽取器**只产出 `reported` 与 `observed`**：
 *   · Claim 来自用户陈述 → `reported`
 *   · Episode 来自真实互动 → `observed`
 *
 * **不产出 `inferred` / `generated`**：那两类（今天的 `character_output`）
 * 在闸 4 就被拒了，因此它们在这一层根本走不到。让它们走不到、
 * 而不是"标成 inferred 让它进库"，正是计划书第 27 节那条
 * "推断不直接成为用户事实"的落地点。
 */
function epistemicStatusFor(
  type: MemoryType,
  _profiles: readonly EvidenceProfile[]
): MemoryEpistemicStatus {
  return isClaimType(type) ? 'reported' : 'observed'
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

// ---------------------------------------------------------------------------
// Prompt（计划书第 46 / 125 节）
// ---------------------------------------------------------------------------

/**
 * 渲染抽取 prompt。
 *
 * ============================================================================
 *  计划书第 125 节：**必须**包含 Actor
 * ============================================================================
 *     否则模型很容易把角色自己的话归到用户头上。
 *
 * 没有 Actor 的对话文本里，"我不喜欢香菜"到底是谁说的只能靠猜 ——
 * 因此这条不是"更清楚一点"，而是**正确性的必要条件**。
 *
 * 计划书第 46 节要求严格 Schema、禁止自由文本。因此 prompt 明确给出
 * JSON 形状，并要求**没有值得记的就返回空数组** ——
 * 那是一个必须被允许的正常结果（计划书第 50 节）。
 */
export function buildExtractionPrompt(input: {
  views: readonly ProcessorEventView[]
  /**
   * 已登记的槽位。**带 description**，不是只有 key。
   *
   * ========================================================================
   *  ⚠️ 为什么必须带 description：一个真实的错槽位
   * ========================================================================
   * 第一版只把 key 拼成一行逗号串交给模型：
   *
   *     food.preference.cilantro, food.avoid.general, education.status, ...
   *
   * 于是 `食物回避` 这件事有两个都"讲得通"的键，而模型只能靠键名的
   * 字面猜。实测（真实模型档 M4X-030「记住，我不吃香菜」）它选了
   * `food.avoid.general` —— 而登记表里 `food.preference.cilantro` 的
   * examples 明确写着 `'我不吃香菜'`。
   *
   * 后果不是"少记了一条"，而是**同一个事实落到两个不同槽位**：
   * canonical key 不同 → 去重层认不出它们是同一件事 →
   * 用户说"我现在能吃香菜了"时找不到要推翻的那一条。
   * 规范化键的整套设计都建立在"同一事实落同一槽位"上。
   *
   * 登记表的 `description` 本来就是为消歧写的
   * （`food.avoid.general` 写的是"**其他**明确表达的食物回避（**宽泛槽位**）"），
   * 只是从未交给模型。这里把它交出去。
   *
   * ⚠️ 仍然**不**把 `examples` 交给模型：那是给人和审计看的说明，
   *    送进去会变成 few-shot，模型会开始照抄例句而不是理解语义。
   *    description 足够消歧（"宽泛槽位"、"其他"这些词就是为此写的）。
   */
  knownPredicates: readonly { key: string; description: string }[]
}): string {
  const lines = input.views.map((view) => {
    const actor =
      view.actorType === 'user'
        ? 'USER'
        : view.actorType === 'character'
          ? 'CHARACTER'
          : 'SYSTEM'
    return `Event ${view.sequence} Actor=${actor}\n${view.content}`
  })

  return [
    '从下面这段对话里找出**值得长期记住**的信息。',
    '',
    '只输出 JSON，不要解释。形状：',
    '{"candidates":[{',
    '  "memoryType":"person_fact"|"preference"|"episode"|"self_experience",',
    '  "subjectToken":"USER"|"CHARACTER",',
    '  "claim":{"predicate":"<点分隔小写键>","value":<任意 JSON>},',
    '  "episode":{"summary":"...","participantTokens":["USER","CHARACTER"]},',
    '  "evidenceEventSequences":[<证据事件的序号>],',
    '  "confidence":0.0,',
    '  "longTermValue":0.0',
    '}]}',
    '',
    '规则（每条都会被程序检查，违反的候选会被直接丢弃）：',
    '1. 只记**稳定**的信息（偏好、身份、长期项目、共同经历）。',
    '   不要记寒暄、天气、一次性的状态（"我今天午饭吃了面"）。',
    '2. **没有值得记的就返回 {"candidates":[]}** —— 这是最常见的正确答案。',
    '3. `evidenceEventSequences` 必须是上面真实出现的序号，不能编。',
    '4. 不要声明信息来源：来源由证据事件本身决定。',
    '5. `subjectToken` 用 USER / CHARACTER，不要写具体名字或 id。',
    '6. 角色自己说的话**不是**关于用户的事实。',
    '7. **选最具体的槽位**：如果同时有一个专用槽位和一个宽泛槽位',
    '   （说明里写着"其他""宽泛"的那种）都讲得通，用专用槽位。',
    '   宽泛槽位只在确实没有专用槽位时用。',
    '',
    '已登记的 predicate（**优先用它们**；确实没有合适的才自造点分隔小写键）：',
    ...input.knownPredicates.map((spec) => `- ${spec.key}：${spec.description}`),
    '',
    '对话：',
    ...lines,
  ].join('\n')
}

/**
 * 解析模型输出。
 *
 * ⚠️ 解析失败**不尝试修复 JSON**（计划书第 146 节：
 * "不能自动尝试猜 JSON"）。猜出来的东西会被当成真实记忆写下去，
 * 而那时已经无法回溯判断它到底是谁的意思。
 *
 * 返回 `undefined` = 这一轮抽不出结构化候选；调用方按 policy
 * 决定重试还是让 job 失败（第 146 节）。
 */
export function parseCandidatesJson(raw: string): CandidateDescriptor[] | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const list = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(list)) return undefined

  const out: CandidateDescriptor[] = []
  for (const item of list) {
    const descriptor = parseOneDescriptor(item)
    // 单条不合法 → 丢掉它，**不让整批失败**：
    // 一次抽取里部分候选不合法是正常现象（计划书第 50 节）
    if (descriptor !== undefined) out.push(descriptor)
  }
  return out
}

function parseOneDescriptor(item: unknown): CandidateDescriptor | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>

  if (typeof record.memoryType !== 'string') return undefined
  const subjectToken = record.subjectToken
  if (subjectToken !== 'USER' && subjectToken !== 'CHARACTER') return undefined

  const evidenceRaw = record.evidenceEventSequences
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0) return undefined
  const evidenceEventSequences = evidenceRaw.map((v) =>
    typeof v === 'number' ? v : Number(v)
  )
  if (!evidenceEventSequences.every((n) => Number.isSafeInteger(n) && n > 0)) return undefined

  const descriptor: CandidateDescriptor = {
    memoryType: record.memoryType as MemoryType,
    subjectToken,
    evidenceEventSequences,
  }

  if (typeof record.claim === 'object' && record.claim !== null) {
    const claim = record.claim as Record<string, unknown>
    if (typeof claim.predicate !== 'string' || claim.predicate.trim() === '') return undefined
    if (!('value' in claim)) return undefined
    descriptor.claim = {
      predicate: claim.predicate,
      value: claim.value,
      ...(typeof claim.qualifiers === 'object' && claim.qualifiers !== null
        ? { qualifiers: claim.qualifiers as Record<string, unknown> }
        : {}),
    }
  }

  if (typeof record.episode === 'object' && record.episode !== null) {
    const episode = record.episode as Record<string, unknown>
    if (typeof episode.summary !== 'string' || episode.summary.trim() === '') return undefined
    const tokens = Array.isArray(episode.participantTokens)
      ? episode.participantTokens.filter(
          (t): t is 'USER' | 'CHARACTER' => t === 'USER' || t === 'CHARACTER'
        )
      : []
    descriptor.episode = {
      summary: episode.summary,
      participantTokens: tokens.length > 0 ? tokens : [subjectToken],
      ...(Array.isArray(episode.topicTags)
        ? { topicTags: episode.topicTags.filter((t): t is string => typeof t === 'string') }
        : {}),
    }
  }

  if (typeof record.confidence === 'number') descriptor.confidence = record.confidence
  if (typeof record.longTermValue === 'number') descriptor.longTermValue = record.longTermValue
  if (typeof record.occurredAt === 'number' && Number.isFinite(record.occurredAt)) {
    descriptor.occurredAt = record.occurredAt
  }

  // ⚠️ 刻意**不读** `record.authority` —— 见文件头规矩 3

  return descriptor
}

// ---------------------------------------------------------------------------
// 抽取器实现
// ---------------------------------------------------------------------------

export interface MemoryExtractionResult {
  candidates: MemoryCandidate[]
  /** 被拒绝的候选与原因（进 trace 的 `memory.rejected_count`） */
  rejected: { reason: string; detail: string }[]
  /** 这一批里有没有值得记的（`false` 是**正常结果**） */
  extracted: boolean
}

export interface MemoryExtractionInput {
  views: readonly ProcessorEventView[]
  owner: EntityRef
  speaker: EntityRef
}

export interface MemoryExtractor {
  readonly name: string
  readonly version: string
  /**
   * 处理一批事件，产出零到多个候选。
   *
   * 契约与 `CharacterProcessor` 一致（计划书第 47 节：抽取器**不负责最终写入**）：
   *   · 允许返回空（"这批对话不值得记"是正常结论）
   *   · 抛错 = 任务失败，由 Job 层决定重试
   */
  process(
    input: MemoryExtractionInput,
    context: ProcessorContext
  ): Promise<MemoryExtractionResult>
}

/**
 * 生产抽取器：调模型，然后**把输出关进契约**。
 *
 * 模型调用**必须**通过 `context.invokeModel`（由基础设施注入）——
 * 那是 `ProcessorContext` 存在的理由：领域侧只声明"我需要一次模型调用"，
 * 具体走哪个 provider / 哪次 trace 由外层决定。
 * 因此这个类**不 import 任何 provider**。
 */
export class LlmMemoryExtractor implements MemoryExtractor {
  readonly name = MEMORY_EXTRACTOR_NAME
  readonly version = MEMORY_EXTRACTOR_VERSION

  async process(
    input: MemoryExtractionInput,
    context: ProcessorContext
  ): Promise<MemoryExtractionResult> {
    if (context.invokeModel === undefined) {
      /*
       * 没有模型入口 → **抛错**（让 Job 失败并重试），不是返回空。
       *
       * 返回空会被上层读成"这一批没有值得记的" —— 那是一个**错误的结论**：
       * 真实原因是"抽取器根本没跑"。两者的区别在运维上很关键
       * （一个是正常的 REJECT，一个是配置缺陷），而混淆它们
       * 会让配置问题永远不被发现（永远"0 条记忆，一切正常"）。
       */
      throw new KernelError(
        'processor_error',
        'memory_extractor_without_model',
        '后台抽取需要模型入口，但 ProcessorContext.invokeModel 未注入。' +
          '返回空会让"配置缺陷"看起来像"这批对话不值得记"',
        { processor: this.name, version: this.version }
      )
    }

    /*
     * `L-M97-02` **问句守卫**（2026-10-04）：批量 prompt 里**剔除**问句轮 ——
     * 与规则抽取器同一道判据；这里剔除还能顺带省钱（问句不进模型）。
     * 全部被剔除 ⇒ `views` 为空 ⇒ 下面的 `buildExtractionPrompt` 会拿到空集，
     * 与"这一批没有可抽的"同路（不新增失败码）。
     */
    const extractableViews = input.views.filter((view) => !isQuestionLike(view.content))
    const prompt = buildExtractionPrompt({
      views: extractableViews,
      // 连 description 一起给模型：只有 key 会让重叠槽位（专用 vs 宽泛）
      // 靠键名字面猜，实测会选错（见 `buildExtractionPrompt` 的说明）
      knownPredicates: registeredPredicates().map((spec) => ({
        key: spec.key,
        description: spec.description,
      })),
    })
    const raw = await context.invokeModel(prompt, { purpose: 'memory-extraction' })

    /*
     * ⚠️ **空输出**与**格式错误**必须分开报（实测踩到过）。
     *
     * 第一版把两者都归到 `memory_extractor_malformed_output`。
     * 而它们的成因与处置**完全不同**：
     *
     *   空输出     —— 模型什么都没说。最常见的原因是
     *                **推理模型的推理 token 吃光了 max_tokens**
     *                （实测：deepseek-flash 是推理模型，1200 的预算下
     *                 长 prompt 会让 content 为空、finish_reason=length）。
     *                处置：调大预算或换非推理模型 —— 改 prompt 没用
     *   格式错误   —— 模型说了话但形状不对。处置：改 prompt / 加示例
     *
     * 混成一个错误码会让排查方向直接跑偏（"格式不对"→去改 prompt，
     * 而真实原因是预算不够）。这与本项目反复出现的那类缺陷同形：
     * **错误码把两种不同的世界状态压成了一个**。
     */
    if (raw.trim() === '') {
      throw new KernelError(
        'processor_error',
        'memory_extractor_empty_output',
        '抽取器返回了**空输出**。最常见的原因是推理模型的推理 token 吃光了 ' +
          'max_tokens（此时 content 为空而 finish_reason=length）—— ' +
          '那不是"格式不对"，改 prompt 没用，要调大预算或换模型',
        { processor: this.name, version: this.version }
      )
    }

    const descriptors = parseCandidatesJson(raw)

    if (descriptors === undefined) {
      // ⚠️ 不猜 JSON。重试由 Job 层按 policy 决定（计划书第 146 节）
      throw new KernelError(
        'processor_error',
        'memory_extractor_malformed_output',
        '抽取器返回了无法解析的结构化候选（计划书第 146 节：不能自动尝试猜 JSON）',
        { processor: this.name, version: this.version, rawLength: raw.length }
      )
    }

    return finalize(
      resolveCandidates(descriptors, {
        owner: input.owner,
        events: input.views,
        speaker: input.speaker,
        processor: this.name,
        processorVersion: this.version,
      })
    )
  }
}

/**
 * 离线 / CI 用的抽取器：**不调模型**，只按一张很短的线索表做确定性识别。
 *
 * 它与 `content-extractor.ts` 的规则表**不是同一份**：
 *   · 那份处理"用户明确要求记住的一句话"（输入是短句）
 *   · 这份处理"一段对话"（输入是多条带 Actor 的事件），
 *     并且**必须**判断"这句话是谁说的"——那正是 Source Firewall 的入口，
 *     也是它在离线测试里**唯一**无法被绕过的地方
 *
 * 它同样**允许不完整**：未覆盖的说法返回空候选（正常结果）。
 */
export class RuleBasedMemoryExtractor implements MemoryExtractor {
  readonly name = MEMORY_EXTRACTOR_NAME
  readonly version = `${MEMORY_EXTRACTOR_VERSION}-rule`

  async process(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
    const descriptors: CandidateDescriptor[] = []

    for (const view of input.views) {
      // 只看用户的话。她自己的输出**不产生**候选 —— 这既是省事也是正确：
      // 她的输出本来也建不了用户事实（闸 4 会拒），
      // 而在这里就跳过它，让"她的猜测不会变成事实"多一道结构上的保证。
      if (view.actorType !== 'user') continue
      /*
       * `L-M97-02` **问句守卫**（2026-10-04）：这条链今天 **NOT-WIRED**（`TD-19`），
       * 但它走的是**另一张线索表**（`RULE_CUES`）—— 不在这里镜像一处，TD-19 接上之后
       * 问句照样会被记成事实（审计原话："不能为拦问句误拒合法引用"，但也不能只守一半）。
       */
      if (isQuestionLike(view.content)) continue
      const descriptor = ruleDescriptorFor(view)
      if (descriptor !== undefined) descriptors.push(descriptor)
    }

    return finalize(
      resolveCandidates(descriptors, {
        owner: input.owner,
        events: input.views,
        speaker: input.speaker,
        processor: this.name,
        processorVersion: this.version,
      })
    )
  }
}

/**
 * 离线线索表。
 *
 * **故意很短**：它只服务于"离线行为可被断言"，不是生产质量的抽取器。
 * 每加一条都要问"这条在测试里守着什么不变量" ——
 * 否则它会悄悄变成一份不完整的中文词表，而那份不完整没有任何测试能守住。
 */
const RULE_CUES: readonly {
  cue: string
  predicate: string
  value: unknown
  type: MemoryType
}[] = [
  { cue: '不吃香菜', predicate: 'food.preference.cilantro', value: 'dislike', type: 'preference' },
  { cue: '喜欢香菜', predicate: 'food.preference.cilantro', value: 'like', type: 'preference' },
  { cue: '不喜欢香菜', predicate: 'food.preference.cilantro', value: 'dislike', type: 'preference' },
  { cue: '大学生', predicate: 'education.status', value: 'undergraduate', type: 'person_fact' },
  { cue: '研究生', predicate: 'education.status', value: 'graduate', type: 'person_fact' },
  { cue: '不喜欢辣', predicate: 'food.avoid.general', value: '回避辣', type: 'preference' },
]

function ruleDescriptorFor(view: ProcessorEventView): CandidateDescriptor | undefined {
  for (const rule of RULE_CUES) {
    if (!view.content.includes(rule.cue)) continue
    return {
      memoryType: rule.type,
      subjectToken: 'USER',
      claim: { predicate: rule.predicate, value: rule.value },
      evidenceEventSequences: [view.sequence],
      confidence: 0.8,
      longTermValue: 0.7,
    }
  }
  return undefined
}

function finalize(resolved: readonly ResolvedCandidate[]): MemoryExtractionResult {
  return {
    candidates: resolved.flatMap((r) => (r.ok ? [r.candidate] : [])),
    rejected: resolved.flatMap((r) => (r.ok ? [] : [r.rejection])),
    extracted: resolved.some((r) => r.ok),
  }
}
