/**
 * M5 WP2 —— **Eligibility Filter**（P0 安全层）。
 *
 * ============================================================================
 *  它是 M5 最重要的一个文件
 * ============================================================================
 * 计划书把这条链写死了：
 *
 *     Candidate Retrieval  →  Eligibility Filter  →  Eligible Candidate
 *
 * 而**绝不允许**：
 *
 *     Candidate  →  Prompt
 *
 * 也就是说：这个文件是"一条记忆能不能出现在她眼前"的**唯一**判断处。
 * 判断散落到多个 ContextSectionProvider 里，就会出现"加了第三个 provider
 * 之后跨用户泄漏又回来了"——那种缺陷不报错，只是她的上下文里多了别人说的话。
 *
 * ---------------------------------------------------------------------------
 *  四条纪律（都是被本项目的真实事故教出来的）
 * ---------------------------------------------------------------------------
 * 1. **不复制 M4 的生命周期语义**（AT2.2）。
 *    可召回与否**只**问 `exclusionReasonForStatus()` —— 它内部用的是 M4 的
 *    `isRecallEligible()`。这个文件里**不出现** `'retracted'` / `'superseded'`
 *    这两个状态字面量（由静态锁守着），因此 M4 改语义时它自动跟着变。
 *
 * 2. **不猜**（AT2.4 / ADR-032）。
 *    `target` 是 `not_found` / `ambiguous` 时，**没有任何候选**可以通过 ——
 *    包括那些看起来"很像"的。计划书 WP2 的 Hard Gate 里
 *    `invalid-target leakage = 0` 指的就是这件事：
 *    不确定就不选，而不是"选一条最接近的"。
 *
 * 3. **用户隔离是 subject 级**（AT2.3）。
 *    `memory_records` 没有 user_id（M4 的 owner 是角色、subject 才是人），
 *    因此"这条记忆讲的是不是本次请求的这个人"必须逐候选比对 subjects。
 *    这也是 `wrong-user leakage = 0` 唯一的拦截面。
 *
 * 4. **阶段与理由由契约唯一决定**（WP1）。
 *    本文件只输出 `{ eligible, reason, code }`；它不构造 `selected`，
 *    也不碰排序与预算 —— 于是"资格拒绝 / 排序淘汰 / 预算装不下"三分
 *    在类型上就不会被混淆。
 *
 * ---------------------------------------------------------------------------
 *  判定顺序（顺序即"理由归属"，不是随意的）
 * ---------------------------------------------------------------------------
 *    ① owner（namespace）  → WRONG_NAMESPACE
 *    ② subjects（user）     → WRONG_USER
 *    ③ target              → INVALID_TARGET
 *    ④ lifecycle status    → FORGOTTEN / SUPERSEDED
 *    ⑤ disputed 策略        → POLICY
 *    ⑥ 状态完整性           → ORPHANED_EVIDENCE
 *    ⑦ 请求的种类           → POLICY
 *    ⑧ 权威下界             → POLICY
 *
 * 为什么 owner 与 subject 排在 target 之前：它们是**隔离**判据。
 * 一条属于别人的记忆，无论目标解析得多准都不该进入下一步 ——
 * 把隔离放在后面会让"目标恰好匹配"成为绕过隔离的路径。
 */

import {
  KernelError,
  assertRecallDecision,
  compareAuthority,
  entityLabel,
  exclusionReasonForStatus,
  type EntityRef,
  type MemoryAuthority,
  type RecallCandidate,
  type RecallDecision,
  type RecallExclusionReason,
  type RecallRequest,
  type RecallScoreBreakdown,
} from '../contracts/index.ts'

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

export interface RecallEligibilityPolicy {
  /**
   * 允许的**最低**权威等级（含）。缺省不限制 —— 计划书里的
   * "invalid authority when policy forbids" 就是这一条。
   */
  minAuthority?: MemoryAuthority
  /**
   * 历史查询是否允许 `superseded`（缺省 **true**）。
   *
   * 计划书 WP4 的 Historical Query（"以前……"）与 Current vs Superseded
   * （"现在"只能拿 active）是**两条相反**的要求，而它们的区别只在 intent。
   * 因此这个开关由 intent 驱动，而不是把 superseded 一刀切掉。
   */
  allowSupersededForHistorical?: boolean
  /**
   * 是否允许 `disputed`（缺省 **true**，与 M4 的 `isRecallEligible` 一致）。
   *
   * 注意它**不是**生命周期判断，而是策略判断：关掉它时理由是 `POLICY`，
   * 不是 `NOT_ACTIVE` —— 后者是保留位，今天没有生产者
   * （见 `RECALL_EXCLUSION_REASON_FACTS`）。
   */
  allowDisputed?: boolean
}

export const DEFAULT_RECALL_ELIGIBILITY_POLICY: Required<RecallEligibilityPolicy> = {
  minAuthority: 'MODEL_INFERENCE',
  allowSupersededForHistorical: true,
  allowDisputed: true,
}

// ---------------------------------------------------------------------------
// 诊断码（**闭集**：没有自由文本，因此不可能夹带记忆正文）
// ---------------------------------------------------------------------------

/**
 * 比 `reason` 更细一层的诊断码。
 *
 * 为什么它需要存在：`INVALID_TARGET` 至少有三种成因（目标没找到 / 判不出来 /
 * 候选与已解析的目标不是同一个人），而排错时要看的就是这个区别。
 *
 * 为什么它是**闭集**而不是一句人话：`note` 之类的自由文本会很容易把
 * 记忆正文抄进去，而那段文字可能进 trace —— 计划书 WP7 的隐私纪律在
 * 契约层已经锁过一次（`serializeContextBundleForTrace` 不含正文），
 * 这里用枚举把同一条纪律延伸到诊断信息上。
 */
export type RecallEligibilityCode =
  | 'eligible'
  | 'owner_mismatch'
  | 'subject_missing_user'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'target_subject_not_in_candidate'
  | 'status_forgotten'
  | 'source_withdrawn'
  | 'status_superseded_current_query'
  | 'status_disputed_not_allowed'
  | 'status_not_recallable'
  | 'integrity_orphaned'
  | 'kind_not_requested'
  | 'authority_below_policy'

export interface EligibilityVerdict {
  eligible: boolean
  /** 不可用时**必有**；可用时**不许有**（与 `RecallDecision` 同一条规则） */
  reason?: RecallExclusionReason
  code: RecallEligibilityCode
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

export interface EvaluateEligibilityInput {
  request: RecallRequest
  candidate: RecallCandidate
  policy?: RecallEligibilityPolicy
  withdrawnEventIds?: ReadonlySet<string>
}

/** 语义化：可用的那一个 */
const ELIGIBLE: EligibilityVerdict = { eligible: true, code: 'eligible' }

function reject(reason: RecallExclusionReason, code: RecallEligibilityCode): EligibilityVerdict {
  return { eligible: false, reason, code }
}

function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && String(a.id) === String(b.id)
}

/**
 * 一条候选能不能进入下一阶段。
 *
 * **纯函数**：没有 IO、没有时间、没有随机 —— 因此它可以被穷举测试
 * （WP2 的矩阵测试就是这么做的），也可以在任何层被复算。
 */
export function evaluateEligibility(input: EvaluateEligibilityInput): EligibilityVerdict {
  const { request, candidate } = input
  const policy: Required<RecallEligibilityPolicy> = {
    ...DEFAULT_RECALL_ELIGIBILITY_POLICY,
    ...(input.policy ?? {}),
  }

  // ① namespace：Memory Space 属于角色
  if (
    candidate.owner.kind !== 'character' ||
    String(candidate.owner.id) !== String(request.characterId)
  ) {
    return reject('WRONG_NAMESPACE', 'owner_mismatch')
  }

  // ② user：这条记忆讲的是不是这个人
  const aboutUser = candidate.subjects.some((subject) => sameEntity(subject, request.user))
  if (!aboutUser) {
    return reject('WRONG_USER', 'subject_missing_user')
  }

  // ③ target：不确定就不选（ADR-032）
  const target = request.target
  if (target.status === 'not_found') {
    return reject('INVALID_TARGET', 'target_not_found')
  }
  if (target.status === 'ambiguous') {
    return reject('INVALID_TARGET', 'target_ambiguous')
  }
  if (target.status === 'resolved') {
    const matches = candidate.subjects.some((subject) => sameEntity(subject, target.subject))
    if (!matches) {
      // 目标解析说是关于 X 的，但这条记忆讲的是别人 —— 它不是"没关系"，是"对不上"
      return reject('INVALID_TARGET', 'target_subject_not_in_candidate')
    }
  }
  // target.status === 'none' → 本轮没有实体目标（例如"你还记得我在哪所大学吗"），
  // 只受 subject 隔离约束。这是**刻意的**：把 none 一律拒绝会让用户问自己的事也叫不回来。

  // ④ lifecycle：**只**问契约层，不在这里重复 M4 的语义（AT2.2）
  const statusReason = exclusionReasonForStatus(candidate.status)
  if (statusReason === 'SUPERSEDED') {
    const historical = request.intent === 'historical' && policy.allowSupersededForHistorical
    if (!historical) {
      return reject('SUPERSEDED', 'status_superseded_current_query')
    }
  } else if (statusReason !== undefined) {
    /*
     * 今天只有 `FORGOTTEN` 会走到这里（`SUPERSEDED` 在上面被 intent 分流了）。
     * 将来 M4 新增状态时，`exclusionReasonForStatus` 会先在**编译期**失败；
     * 那时这个 else 分支会给出 `status_not_recallable`，而不是被误记成"她要求忘掉的"。
     */
    return reject(
      statusReason,
      statusReason === 'FORGOTTEN' ? 'status_forgotten' : 'status_not_recallable'
    )
  }

  // ⑤ disputed 的策略（不是生命周期）
  if (candidate.status === 'disputed' && !policy.allowDisputed) {
    return reject('POLICY', 'status_disputed_not_allowed')
  }

  // ⑥ 状态完整性：证据/事件流已不存在（M5-PRE 的探针结论，由装配层填进候选）
  if (!candidate.integrityOk) {
    return reject('ORPHANED_EVIDENCE', 'integrity_orphaned')
  }

  // 来源撤销适用于全部记忆类型，与 Episode 的认知资格标签无关。
  if (candidate.sourceRefs.some(ref => input.withdrawnEventIds?.has(ref.id))) {
    return reject('FORGOTTEN', 'source_withdrawn')
  }

  // ⑦ 请求限定的记忆种类
  if (request.memoryKinds !== undefined && !request.memoryKinds.includes(candidate.type)) {
    return reject('POLICY', 'kind_not_requested')
  }

  // ⑧ 权威下界（策略）
  //     `compareAuthority(a, b) < 0` 表示 a **更**权威（秩更小），
  //     因此"低于下界"是 `> 0` —— 写成 `< 0` 会让这条闸反向生效，
  //     而那正好会放行最该被拦下的 MODEL_INFERENCE 候选。
  if (compareAuthority(candidate.authority, policy.minAuthority) > 0) {
    return reject('POLICY', 'authority_below_policy')
  }

  return ELIGIBLE
}

/**
 * 判定 → **最终**决策。
 *
 * ⚠️ 它只用于**已经定下来**的决策，因此有两类合法用法：
 *   · 被拒的候选（`selected: false` + 有理由）—— 它们永远不会被选中，裁决即终局
 *   · 被选中的候选（`selected: true`）—— 由 WP5 在选完之后调用
 *
 * ⚠️ **通过资格但还没被选中的候选不能走这里**：那时它没有理由可写，
 *    而契约要求"没进上下文就必须说明为什么"。中间态不是决策 ——
 *    这正是 `EligibilityBatch` 只输出 verdict 而不输出 decisions 的原因。
 */
export function toDecision(input: {
  candidate: RecallCandidate
  verdict: EligibilityVerdict
  selected: boolean
  score?: RecallScoreBreakdown
}): RecallDecision {
  const decision: RecallDecision = {
    memoryId: input.candidate.memoryId,
    eligible: input.verdict.eligible,
    ...(input.verdict.reason !== undefined ? { reason: input.verdict.reason } : {}),
    selected: input.selected,
    ...(input.score !== undefined ? { score: input.score } : {}),
  }
  assertRecallDecision(decision)
  return decision
}

/**
 * 被拒候选的决策（**终局**）。
 *
 * 它们的裁决不会因为后面的排序/预算而改变，因此可以在资格阶段就定稿 ——
 * 这也让 trace 能在召回失败的当口就解释"哪些被拦下了、为什么"。
 */
export function rejectedDecisions(batch: EligibilityBatch): RecallDecision[] {
  return batch.verdicts
    .filter((item) => !item.verdict.eligible)
    .map((item) => toDecision({ candidate: item.candidate, verdict: item.verdict, selected: false }))
}

export interface EligibilityBatch {
  verdicts: { candidate: RecallCandidate; verdict: EligibilityVerdict }[]
  /**
   * 通过资格的那一批（**唯一**允许进入排序的输入）。
   *
   * ⚠️ 这里是 verdict 而不是 `RecallDecision`：通过资格 ≠ 被选中，
   *    而"没进上下文必须有理由"是**终局**决策的规则。中间态不是决策。
   */
  eligible: RecallCandidate[]
}

/**
 * 一批候选 → 资格判定。
 *
 * 它**只**做资格判定：通过的候选交给 WP4 排序、WP5 选择，由它们在**终局**
 * 才写出 `RecallDecision`。这保证了"通过资格"与"被选中"在数据上是两件事 ——
 * 也是这套 trace 能回答"她是没想起来，还是想起来了但没地方放"的前提。
 */
export function filterEligible(input: {
  request: RecallRequest
  candidates: readonly RecallCandidate[]
  policy?: RecallEligibilityPolicy
  withdrawnEventIds?: ReadonlySet<string>
}): EligibilityBatch {
  const out: EligibilityBatch = { verdicts: [], eligible: [] }
  for (const candidate of input.candidates) {
    const verdict = evaluateEligibility({
      request: input.request,
      candidate,
      ...(input.policy !== undefined ? { policy: input.policy } : {}),
      ...(input.withdrawnEventIds !== undefined ? { withdrawnEventIds: input.withdrawnEventIds } : {}),
    })
    out.verdicts.push({ candidate, verdict })
    if (verdict.eligible) out.eligible.push(candidate)
  }
  return out
}

/**
 * 泄漏计数器 —— WP2 Hard Gate 的量具。
 *
 * 计划书要求三条：
 *
 *     forgotten leakage = 0 · wrong-user leakage = 0 · invalid-target leakage = 0
 *
 * 它**不**问"分类器给出的理由对不对"，而是问一个更强的问题：
 * **有没有任何一条被放行的候选违反了这三条规则**。理由写错但没放行，
 * 是可用性问题；放行了才叫泄漏。两者必须分开测量 —— 这正是本项目
 * "量具自己也要被验证"的那条纪律（INV-M45-06）。
 */
export interface EligibilityLeakage {
  forgotten: number
  wrongUser: number
  wrongNamespace: number
  invalidTarget: number
  orphanedEvidence: number
  totalEligible: number
}

export function measureLeakage(input: {
  request: RecallRequest
  verdicts: readonly { candidate: RecallCandidate; verdict: EligibilityVerdict }[]
}): EligibilityLeakage {
  const leakage: EligibilityLeakage = {
    forgotten: 0,
    wrongUser: 0,
    wrongNamespace: 0,
    invalidTarget: 0,
    orphanedEvidence: 0,
    totalEligible: 0,
  }

  for (const { candidate, verdict } of input.verdicts) {
    if (!verdict.eligible) continue
    leakage.totalEligible += 1

    /*
     * ⚠️ 量具必须用**与判定同一套**语义。
     *
     * 第一版这里写的是 `candidate.status === 'retracted'` —— 它是对的，
     * 但它是"第二处状态判断"。静态锁直接把它抓了出来（`pnpm m5:verify` 的
     * §⑥"不出现状态字面量"）。M4 一旦改状态名，判定会自动跟着变，
     * 而这个量具会**静默地**继续数一个不存在的维度 —— 于是"零泄漏"变成一句空话。
     *
     * 这也正是"量具自己也要被验证"（INV-M45-06）在代码层面的样子。
     */
    if (exclusionReasonForStatus(candidate.status) === 'FORGOTTEN') leakage.forgotten += 1
    if (!candidate.subjects.some((subject) => sameEntity(subject, input.request.user))) {
      leakage.wrongUser += 1
    }
    if (
      candidate.owner.kind !== 'character' ||
      String(candidate.owner.id) !== String(input.request.characterId)
    ) {
      leakage.wrongNamespace += 1
    }
    if (input.request.target.status === 'not_found' || input.request.target.status === 'ambiguous') {
      leakage.invalidTarget += 1
    }
    if (!candidate.integrityOk) leakage.orphanedEvidence += 1
  }

  return leakage
}

/** 便于诊断/证据：一条裁决压成一行（**不含正文**） */
export function describeVerdict(input: {
  candidate: RecallCandidate
  verdict: EligibilityVerdict
}): string {
  const subject = input.candidate.subjects.map((item) => entityLabel(item)).join('+') || '（无）'
  return (
    `${String(input.candidate.memoryId)} ${input.verdict.eligible ? 'ELIGIBLE' : 'REJECTED'}` +
    `${input.verdict.reason !== undefined ? `(${input.verdict.reason}/${input.verdict.code})` : ''} ` +
    `owner=${entityLabel(input.candidate.owner)} subjects=${subject}`
  )
}

/**
 * 装配层的一次自检（失败关闭）。
 *
 * 它拦的是"候选与请求根本不是同一个角色/同一个人"这种装配错误 ——
 * 那种错会让后面的泄漏计数全部失去意义（因为量具测的是一批错数据）。
 */
export function assertCandidateMatchesRequestScope(input: {
  request: RecallRequest
  candidates: readonly RecallCandidate[]
}): void {
  const foreignOwner = input.candidates.filter(
    (candidate) =>
      candidate.owner.kind !== 'character' ||
      String(candidate.owner.id) !== String(input.request.characterId)
  )
  if (foreignOwner.length > 0) {
    throw new KernelError(
      'validation_error',
      'recall_candidate_foreign_owner',
      `有 ${foreignOwner.length} 条候选的 owner 不是本次请求的角色：` +
        `${foreignOwner.slice(0, 3).map((c) => String(c.memoryId)).join(', ')}。` +
        '这意味着检索适配器没有按 Memory Space 收窄 —— 它必须在资格判定**之前**修好，' +
        '否则泄漏计数测的是一批本不该送进来的数据'
    )
  }
}
