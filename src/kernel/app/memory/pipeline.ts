/**
 * MemoryExtractionPipeline —— **把后台抽取的各层串成一条链**（计划书第 42／123 节）。
 *
 * ============================================================================
 *  它对应计划书第 42 节那张生命周期图的后台半边
 * ============================================================================
 *     Conversation Events
 *             ↓
 *     Memory Extraction                 ← `extractor.ts`
 *             ↓
 *     MemoryCandidate
 *             ↓
 *     Normalization                     ← `createMemoryCandidate` 内（predicate 规范化）
 *             ↓
 *     Authority Classification          ← `resolveCandidates` 的闸 3（**由证据推导**）
 *             ↓
 *     Epistemic Classification          ← `epistemicStatusFor`
 *             ↓
 *     Value Evaluation                  ← `value.ts`（Value Gate 在此 REJECT）
 *             ↓
 *     Conflict / Duplicate Analysis     ← 放行口的第一层去重（第二层在 Phase 6）
 *             ↓
 *     MemoryPolicyDecision
 *             ↓
 *     Domain Event                      ← `applyAcceptedEvents`
 *             ↓
 *     Memory Reducer
 *             ↓
 *     MemoryRecord                      ← `store.apply`
 *
 * 这个文件**不实现**任何一层，它只负责**顺序与事务边界**。
 * 把顺序收在一处的好处是：计划书那条链的每一步都可以被逐节点断言
 * （"Value Gate 在 Policy 之前"、"权威分类在 Evidence 校验之后"），
 * 而散在各处的调用顺序是不可断言的。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 事务边界（计划书第 159–160 节）
 * ---------------------------------------------------------------------------
 *     LLM 调用（抽取）        ← 事务外
 *     ─────────── transaction ───────────
 *     放行校验 → 领域事件 → 投影
 *     ─────────── commit ────────────────
 *
 * 抽取（可能调模型）与提交之间**必须**隔着这条线。因此本函数的形状是
 * "先 await 抽取、再 await 提交"，中间没有任何持锁操作。
 */

import {
  KernelError,
  slotOfCandidate,
  type DomainEvent,
  type EntityRef,
  type MemoryCandidate,
  type MemoryRecord,
} from '../../contracts/index.ts'
import type { ProcessorContext } from '../../contracts/processor.ts'
import type { ConversationEvent } from '../../contracts/index.ts'
import { analyzeConflict, resolveConflict } from './conflict.ts'
import {
  MEMORY_EXTRACTOR_NAME,
  MEMORY_EXTRACTOR_VERSION,
  processorEventViewOf,
  type MemoryExtractor,
} from './extractor.ts'
import {
  acceptedByValueGate,
  applyValueGate,
  type EvaluateValueOptions,
  type ValueGatedCandidate,
} from './value.ts'
import type {
  MemoryMutationValidator,
  MemoryValidationOutcome,
} from '../../policies/memory-validator.ts'

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

export interface MemoryPipelineOutcome {
  /** 抽取器产出的候选数（`memory.candidate_count`） */
  candidates: number
  /** 通过值评估的数量 */
  valuePassed: number
  /** 被值闸拒绝的数量（`memory.rejected_count` 的一部分） */
  valueRejected: number
  /** 放行口接受的数量（`memory.accepted_count`） */
  accepted: number
  /** 放行口拒绝的数量 */
  policyRejected: number
  /** 幂等命中数（"这件事之前已经生效过"） */
  deduplicated: number
  /** 真正落库并折叠成功的记录 */
  created: MemoryRecord[]
  /** 逐条拒绝原因（进 trace 与审计；**不含**候选正文） */
  rejections: { stage: MemoryPipelineStage; reason: string; detail: string }[]
}

/** 链上的哪一步拒绝的 */
export type MemoryPipelineStage = 'extraction' | 'value' | 'conflict' | 'policy' | 'commit'

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/**
 * 冲突分析需要的**槽位读取端口**。
 *
 * M6.1 WP4 / ADR-055 `D-55b`：把它抽成**具名类型**，让**显式路径**与提取管线
 * 共用**同一个**端口形状 —— 用户批准的 A 要求"与 `pipeline.ts` 同一实现、不得复制一份"。
 *
 * ⚠️ 语义（由既有的测试实现定义，不是新造）：
 * ```text
 * 取该槽位上 **ACTIVE 与 DISPUTED** 的记录。
 * 为什么去重（validator 的第一、二层）仍然只查 ACTIVE：
 *   RETRACTED 与 SUPERSEDED 的记录不该阻止新记忆建立
 *   （用户"忘掉"之后重新说同一件事，应当能重新记住）。
 * 而 DISPUTED 属于"还没定论"，因此它要参与冲突分析、不参与去重。
 * ```
 */
export interface MemoryConflictPort {
  recordsInCanonicalSlot(input: {
    owner: EntityRef
    canonicalKey: string
  }): Promise<MemoryRecord[]>
}

export interface MemoryPipelineDeps {
  extractor: MemoryExtractor
  validator: MemoryMutationValidator
  /** 折叠：写投影（`store.apply`） */
  fold: (event: DomainEvent) => Promise<{ record: MemoryRecord | null }>
  /** 提交：写 `character_domain_events`（`applyAcceptedEvents`） */
  commit: (accepted: MemoryValidationOutcome['accepted'], now: number) => Promise<DomainEvent[]>
  /** 值闸参数（阈值 / 是否显式） */
  valueOptions?: EvaluateValueOptions
  /**
   * 冲突分析的读取口（计划书第 79–82 节，Phase 6）。
   *
   * ============================================================================
   *  ⚠️ 必须返回 **ACTIVE 与 DISPUTED 两种**，不能只返回 ACTIVE
   * ============================================================================
   * 第一版只返回 ACTIVE，于是：
   *
   *     一条记忆被判为 DISPUTED（矛盾、判不了）
   *     ↓ 后续用户说"我现在改听摇滚了"（带状态变化标记）
   *     ↓ 槽位里"没有 ACTIVE" → 判为 NO_CONFLICT → **只建新条**
   *     ↓ 那条 DISPUTED 永远保持 DISPUTED
   *
   * 而计划书第 33 节写得很清楚：
   *
   *     可以进入 DISPUTED，**直到后续 Evidence 澄清**。
   *
   * 也就是说 DISPUTED 是**待澄清**，不是终态 —— 后续证据必须能让它落定。
   * 只查 ACTIVE 会让它永远等不到那一步，而那个缺陷**不报错**：
   * 库里看起来"多了一条新记忆"，而那条悬着的 DISPUTED 谁也不管。
   *
   * 为什么去重（validator 的第一、二层）仍然只查 ACTIVE：
   * RETRACTED 与 SUPERSEDED 的记录不该阻止新记忆建立
   * （用户"忘掉"之后重新说同一件事，应当能重新记住）。
   * 而 DISPUTED 属于"还没定论"，因此它要参与冲突分析、不参与去重。
   *
   * ⚠️ M6.1 WP4 / ADR-055 `D-55b`：端口形状已抽成具名的 [`MemoryConflictPort`]，
   *    由**提取管线与显式路径共用**（用户批准的 A 要求"同一实现、不得复制一份"）。
   */
  conflict?: MemoryConflictPort
  /** 用户的原话（判断"有没有状态变化标记"，见 `conflict.ts` 的说明） */
  utterance?: string
  now?: () => number
}

export interface RunMemoryPipelineInput {
  owner: EntityRef
  /** 本批次的事件（已按 sequence 升序）。**必须是真实账本事件** */
  events: readonly ConversationEvent[]
  /** 这些事件讲的是谁（通常是解析出的用户） */
  speaker: EntityRef
  /** 抽取器上下文（`invokeModel` 由装配层注入） */
  processorContext: ProcessorContext
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 跑一次后台抽取。
 *
 * 返回**结果对象而不是抛错**（除了输入形状错误）：
 * 计划书第 144 节要求"background extraction: fail → retry，聊天本身正常"。
 * 调用方（`runMemoryExtractionJob`）把失败记进 job，不往上传。
 */
export async function runMemoryExtractionPipeline(
  deps: MemoryPipelineDeps,
  input: RunMemoryPipelineInput
): Promise<MemoryPipelineOutcome> {
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()
  const rejections: MemoryPipelineOutcome['rejections'] = []

  if (input.events.length === 0) {
    // 空区间**不是错误**：它只是一个没有新东西可抽的批次。
    // 但调用方不该排这种任务（`enqueueMemoryExtractionJob` 会拒空区间），
    // 因此这里返回空结果而不是抛错。
    return emptyOutcome()
  }

  // -------------------------------------------------------------------------
  // ① 事件 → 视图（计划书第 124 节：输入必须有来源标签）
  // -------------------------------------------------------------------------
  const views = []
  for (const event of input.events) {
    try {
      views.push(processorEventViewOf(event))
    } catch (error) {
      // 工具事件在这一层被拒（`tool_event_not_extractable_in_m4`）。
      // 它是**批次级**的问题而不是候选级的：跳过那一条事件，
      // 让这一批的其余部分照常处理 —— 一次工具消息不该让整批抽取失败。
      rejections.push({
        stage: 'extraction',
        reason: (error as { code?: string }).code ?? 'view_conversion_failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (views.length === 0) {
    return { ...emptyOutcome(), rejections }
  }

  // -------------------------------------------------------------------------
  // ② 抽取（**事务外**，可能调模型）
  // -------------------------------------------------------------------------
  const extraction = await deps.extractor.process(
    { views, owner: input.owner, speaker: input.speaker },
    input.processorContext
  )
  for (const rejection of extraction.rejected) {
    rejections.push({ stage: 'extraction', ...rejection })
  }

  if (extraction.candidates.length === 0) {
    // ⚠️ **这是正常结果，不是失败**（计划书第 50 节）。
    // 大量普通对话在这里返回 0 条 —— 而那正是健康系统的表现。
    return {
      ...emptyOutcome(),
      rejections,
    }
  }

  // -------------------------------------------------------------------------
  // ③ 值评估（计划书第 51–53 节）—— 纯函数，事务外
  // -------------------------------------------------------------------------
  const gated: ValueGatedCandidate[] = applyValueGate(
    extraction.candidates,
    deps.valueOptions ?? {}
  )
  for (const entry of gated) {
    if (!entry.ok) {
      rejections.push({ stage: 'value', reason: entry.reason, detail: entry.detail })
    }
  }
  const valuePassed = acceptedByValueGate(gated)
  const valueRejected = gated.length - valuePassed.length

  if (valuePassed.length === 0) {
    return {
      ...emptyOutcome(),
      candidates: extraction.candidates.length,
      valueRejected,
      rejections,
    }
  }

  // -------------------------------------------------------------------------
  // ④ 冲突分析（计划书第 79–82 / 129 节，Phase 6）
  //
  //    **必须在放行之前**：放行口只做去重第一层与"同槽位同取值"。
  //    "取值不同"的三种情形（重复 / 时间更新 / 矛盾）由这一层判，
  //    而且它们对应**不同的事件**（不新建 / SUPERSEDE / DISPUTE）——
  //    交给放行口会用同一个 REJECT 把三者都吃掉。
  // -------------------------------------------------------------------------
  const resolvable: MemoryCandidate[] = []
  const pendingSupersede: { target: MemoryRecord; reason: string }[] = []
  const pendingDispute: { target: MemoryRecord; reasons: string[] }[] = []

  if (deps.conflict === undefined) {
    // 没有配置冲突分析 → 全部候选照常走（行为与 Phase 5 一致）
    resolvable.push(...valuePassed)
  } else {
    for (const candidate of valuePassed) {
      const slot = slotOfCandidate(candidate)
      if (slot === undefined) {
        // Episode 家族没有槽位，去重走第三层（本层不处理）
        resolvable.push(candidate)
        continue
      }
      const activeInSlot = await deps.conflict.recordsInCanonicalSlot({
        owner: input.owner,
        canonicalKey: slot.canonicalKey,
      })
      const analysis = analyzeConflict({
        candidate,
        activeInSlot,
        ...(deps.utterance !== undefined ? { utterance: deps.utterance } : {}),
      })
      const resolution = resolveConflict(analysis)

      switch (resolution.action) {
        case 'CREATE':
          resolvable.push(candidate)
          break
        case 'REJECT_DUPLICATE':
          rejections.push({
            stage: 'conflict',
            reason: 'duplicate_canonical',
            detail: resolution.reason,
          })
          break
        case 'SUPERSEDE':
          /*
           * ⚠️ 替代条必须带上 `validFrom = now`（计划书第 36 节）。
           *
           * 计划书给的例子：
           *     旧：Alex 喜欢咖啡   validUntil = 2026-09-16
           *     新：Alex 已经戒咖啡  validFrom  = 2026-09-16
           *
           * **两个边界都要写**。只写旧条的 `validUntil` 会让新条的
           * `validFrom` 是 undefined（= "不知道从什么时候开始有效"），
           * 于是"她是什么时候开始这么认为的"无法回答 ——
           * 而那个问题在排查"她为什么忽然变了"时正是第一个要问的。
           *
           * 这里用浅拷贝（而不是改 candidate）：候选对象可能被别处引用，
           * 悄悄改它会让"我传进去的"与"它拿到的"不再一致。
           */
          resolvable.push({ ...candidate, proposedValidFrom: nowMs })
          pendingSupersede.push({ target: resolution.target, reason: resolution.reason })
          break
        case 'MARK_DISPUTED':
          pendingDispute.push({ target: resolution.target, reasons: [resolution.reason] })
          break
        case 'NEEDS_REVIEW':
          // 判不了 → 如实回报，**不猜、不挑、不覆盖**
          rejections.push({ stage: 'conflict', reason: 'needs_review', detail: resolution.reason })
          break
      }
    }
  }

  if (resolvable.length === 0 && pendingDispute.length === 0) {
    return {
      candidates: extraction.candidates.length,
      valuePassed: valuePassed.length,
      valueRejected,
      accepted: 0,
      policyRejected: 0,
      deduplicated: 0,
      created: [],
      rejections,
    }
  }

  // -------------------------------------------------------------------------
  // ⑤ 放行（事务外：纯校验 + 只读查询）
  // -------------------------------------------------------------------------
  let outcome: MemoryValidationOutcome = { accepted: [], rejected: [], idempotencyKeys: [] }
  if (resolvable.length > 0) {
    try {
      outcome = await deps.validator.validate({
        characterId: characterIdOf(input.owner),
        owner: input.owner,
        candidates: resolvable,
        mutation: 'background',
        operation: 'create',
      })
    } catch (error) {
      /*
       * 放行期间抛错（例如幂等查询失败）→ **向上抛**，让 job 失败并重试。
       *
       * 与"候选被拒"不同：候选被拒是**结论**（这批对话不值得记），
       * 而这里是**故障**（我们没能得出结论）。
       * 把故障降级成"0 条候选"会让它永远不被重试 ——
       * 而那意味着这批事件永远不会被重新处理（水位会越过它们）。
       */
      throw new KernelError(
        'persistence_error',
        'memory_pipeline_validation_failed',
        `放行校验期间发生故障（不是"候选被拒"）：${
          error instanceof Error ? error.message : String(error)
        }`,
        { owner: `${input.owner.kind}:${String(input.owner.id)}` }
      )
    }

    for (const rejection of outcome.rejected) {
      rejections.push({
        stage: 'policy',
        reason: rejection.code,
        detail: rejection.message,
      })
    }
  }

  const deduplicated =
    rejections.filter(
      (r) =>
        r.stage === 'policy' &&
        (r.reason === 'duplicate_operation' || r.reason === 'duplicate_content' || r.reason === 'duplicate_canonical')
    ).length +
    rejections.filter((r) => r.stage === 'conflict' && r.reason === 'duplicate_canonical').length

  if (outcome.accepted.length === 0 && pendingDispute.length === 0) {
    return {
      candidates: extraction.candidates.length,
      valuePassed: valuePassed.length,
      valueRejected,
      accepted: 0,
      policyRejected: rejections.filter((r) => r.stage === 'policy').length,
      deduplicated,
      created: [],
      rejections,
    }
  }

  // -------------------------------------------------------------------------
  // ⑥ 提交 + 折叠
  // -------------------------------------------------------------------------
  // `nowMs` 在函数开头就算好了 —— 冲突分析里的 SUPERSEDE 需要它
  // （替代条的 validFrom 与旧条的 validUntil 必须是**同一个**时刻，
  //   否则区间会出现重叠或空隙）

  /*
   * ⚠️ 顺序：**先建新条，再 supersede 旧条**。
   *
   * 因为 `MEMORY_SUPERSEDED` 需要 `supersededBy`（新条的 memoryId），
   * 而那个 id 由新条的 `MEMORY_CREATED` 事件确定。反过来就只能编一个 id ——
   * 而未必要被建立，于是库里会留下悬空引用。
   *
   * 与显式路径的 `correct` 同一条理由（见 `explicit-service.ts`）。
   */
  const created: MemoryRecord[] = []

  if (outcome.accepted.length > 0) {
    const events = await deps.commit(outcome.accepted, nowMs)
    for (const event of events) {
      const applied = await deps.fold(event)
      if (applied.record !== null) created.push(applied.record)
    }
  }

  // --- supersede：每个被取代的旧条写一条事件 ---------------------------
  for (const entry of pendingSupersede) {
    const replacement = created[created.length - 1]
    if (replacement === undefined) {
      // 新条没建成功（放行口拒了它）→ **不发 supersede**。
      // 那正是"先建新、再 supersede"的收益：失败方向是"两条并存"
      // （可检测的中间态），而不是"旧条被废弃、新条不存在"（记忆丢失）。
      rejections.push({
        stage: 'conflict',
        reason: 'supersede_skipped_no_replacement',
        detail:
          `旧条 ${String(entry.target.id)} 本应被取代，但替代它的新条没有被建立成功。` +
          '因此**不发** supersede —— 旧条继续保持 ACTIVE（宁可并存，不可丢失）',
      })
      continue
    }
    await commitSupersede(deps, input, entry.target, replacement, nowMs)
  }

  // --- dispute：矛盾陈述进 DISPUTED（计划书第 82 节）-------------------
  for (const entry of pendingDispute) {
    await commitDispute(deps, input, entry.target, entry.reasons, nowMs)
    rejections.push({
      stage: 'conflict',
      reason: 'marked_disputed',
      detail: `旧条 ${String(entry.target.id)} 被标记为 DISPUTED（${entry.reasons.join('；')}）`,
    })
  }

  return {
    candidates: extraction.candidates.length,
    valuePassed: valuePassed.length,
    valueRejected,
    accepted: outcome.accepted.length,
    policyRejected: rejections.filter((r) => r.stage === 'policy').length,
    deduplicated,
    created,
    rejections,
  }
}

/**
 * 发一条 `MEMORY_SUPERSEDED`（计划书第 81 节）。
 *
 * 来源是**触发它的那批事件**：这类变更不是"用户明确要求纠正"，
 * 而是后台在后续对话里发现"当前状态变了"。因此它的证据是
 * **那一批事件**，而不是某个单独的点。这是它与显式路径的
 * `correct` 的区别（后者的来源是用户那句"之前那个改一下"）。
 */
async function commitSupersede(
  deps: MemoryPipelineDeps,
  input: RunMemoryPipelineInput,
  target: MemoryRecord,
  replacement: MemoryRecord,
  nowMs: number
): Promise<void> {
  const from = Math.min(...input.events.map((e) => e.sequence))
  const to = Math.max(...input.events.map((e) => e.sequence))
  const outcome = await deps.validator.validate({
    characterId: characterIdOf(input.owner),
    owner: input.owner,
    candidates: [],
    mutation: 'background',
    operation: 'supersede',
    triggeredByEventId: String(input.events[input.events.length - 1].id),
    target: {
      memoryId: target.id,
      supersededBy: replacement.id,
      validUntil: nowMs,
      reason: `后台发现槽位状态变化（事件 ${from}..${to}）`,
    },
  })
  if (outcome.accepted.length === 0) return
  const events = await deps.commit(outcome.accepted, nowMs)
  for (const event of events) await deps.fold(event)
}

/** 发一条 `MEMORY_DISPUTED`（计划书第 82 节：不擅自选一个） */
async function commitDispute(
  deps: MemoryPipelineDeps,
  input: RunMemoryPipelineInput,
  target: MemoryRecord,
  reasons: readonly string[],
  nowMs: number
): Promise<void> {
  const outcome = await deps.validator.validate({
    characterId: characterIdOf(input.owner),
    owner: input.owner,
    candidates: [],
    mutation: 'background',
    operation: 'dispute',
    triggeredByEventId: String(input.events[input.events.length - 1].id),
    target: {
      memoryId: target.id,
      conflictingMemoryIds: [],
      reason: reasons.join('；'),
    },
  })
  if (outcome.accepted.length === 0) return
  const events = await deps.commit(outcome.accepted, nowMs)
  for (const event of events) await deps.fold(event)
}

function emptyOutcome(): MemoryPipelineOutcome {
  return {
    candidates: 0,
    valuePassed: 0,
    valueRejected: 0,
    accepted: 0,
    policyRejected: 0,
    deduplicated: 0,
    created: [],
    rejections: [],
  }
}

/**
 * owner → characterId。
 *
 * 与 `explicit-service.ts` 里的同名转换一致：放行口会自己再校验 owner 的
 * kind，因此这里只需要一个不会崩的转换。
 */
function characterIdOf(owner: EntityRef) {
  return owner.id as unknown as Parameters<MemoryMutationValidator['validate']>[0]['characterId']
}

/** 便于装配层与 trace：本 pipeline 用的 processor 身份 */
export const MEMORY_PIPELINE_PROCESSOR = {
  name: MEMORY_EXTRACTOR_NAME,
  version: MEMORY_EXTRACTOR_VERSION,
} as const

/** 让候选类型参与推导（避免未使用 import 的告警） */
export type { MemoryCandidate }
