/**
 * MemoryMutationValidator —— **Memory 变化的唯一放行口**。
 *
 * ============================================================================
 *  为什么不复用 `DomainPolicyValidator`（M4 审计 §6 F4 的核心裁定）
 * ============================================================================
 * `DomainPolicyValidator` 的幂等键由 `idempotencyKeyFor()` 推导，形状是：
 *
 *     characterId + processor + processorVersion + 源事件序号区间 + operation
 *
 * 它**没有"这是哪条记忆"这个分量**。而记忆抽取的输入形状与它不同：
 *
 *     一个提案（M2.5/M3）      = **一个**工作单元
 *     一次记忆抽取（M4）        = **N 个独立的工作单元**（同一段事件产出多条候选）
 *
 * 于是把同一批候选交给它，它们会算出**同一个幂等键**：
 *
 *     第 1 条写入 → processed_operations 记下那个键
 *     第 2、3 条提交 → 幂等检查命中 → 判为 duplicate_operation → **被丢弃**
 *
 * 这个缺陷的失败方式是**静默的**：系统看起来一切正常，
 * 只是那两条记忆永远不存在。而"她忘了"比"她记错了"更难发现 ——
 * 那正是本项目最不能接受的一类缺陷（计划书第 50 节：
 * "REJECT 必须是正常结果"，但**丢事实不是**）。
 *
 * ---------------------------------------------------------------------------
 *  因此这里**刻意重复**了一部分检查
 * ---------------------------------------------------------------------------
 * 重复的部分（来源存在性 / 归属 / payload 上限 / scope）是为了让 Memory 的
 * 写入不依赖另一个模块的语义；**不重复**的是幂等键的推导方式 ——
 * 那正是两者真正不同的地方。
 *
 * 共用的东西一律共用：`computeIdempotencyKey()`、`DomainEventRegistry` 的
 * `validatePayload` / `maxPayloadBytes`、`assertCharacterInternalScope`。
 *
 * ---------------------------------------------------------------------------
 *  这个放行口**多出来**的三条（`DomainPolicyValidator` 没有的概念）
 * ---------------------------------------------------------------------------
 *   · `assertMemoryAuthorityAllows()` —— 权威够不够建立这类记忆（计划书第 27 / 148 节）
 *   · `assertMemoryEvidence()`        —— 证据与根（MI-03 / 计划书第 40–41 节）
 *   · `assertContentMatchesType()`    —— 内容家族与记忆类型（计划书第 16 / 20 节）
 */

import {
  DOMAIN_EVENT_SCOPE,
  KernelError,
  MEMORY_CREATED,
  MEMORY_DISPUTED,
  MEMORY_MERGED,
  MEMORY_RESTORED,
  MEMORY_RETRACTED,
  MEMORY_SUPERSEDED,
  assertCharacterInternalScope,
  assertContentMatchesType,
  assertMemoryAuthorityAllows,
  assertMemoryEvidence,
  canonicalKeyOf,
  computeIdempotencyKey,
  contentFingerprintOf,
  isClaimContent,
  recordFromCandidate,
  revivalRecordFromCandidate,
  slotFingerprintOf,
  slotOfRecord,
  type CharacterId,
  type DomainEventRegistry,
  type DomainEventScope,
  type EntityRef,
  type MemoryCandidate,
  type MemoryId,
  type MemoryRecord,
} from '../contracts/index.ts'
import type { AcceptedDomainEvent } from './validator.ts'

// ---------------------------------------------------------------------------
// 请求 / 结果
// ---------------------------------------------------------------------------

/**
 * Memory 变更的意图种类。
 *
 * ⚠️ 它与 `ProposalOperation` 的对应关系是**显式**的（不是同一个枚举）：
 * `ProposalOperation` 是"提案要做什么"的通用词表，
 * 而这里是"这条记忆要发生什么"的具体意图 —— 两者词面高度重叠，
 * 但把 `restore` 加进 `ProposalOperation` 会影响所有认知模块的语义。
 * 映射在 `operationFor()` 里，只有一处。
 */
export type MemoryMutationOperation =
  | 'create'
  | 'supersede'
  | 'retract'
  | 'dispute'
  | 'restore'
  | 'merge'

/** 针对**已存在**记忆的操作目标 */
export interface MemoryMutationTarget {
  memoryId: MemoryId
  // --- supersede ---
  supersededBy?: MemoryId
  validUntil?: number
  // --- retract ---
  reason?: string
  note?: string
  // --- dispute ---
  conflictingMemoryIds?: MemoryId[]
  // --- merge ---
  winnerId?: MemoryId
  loserIds?: MemoryId[]
}

export interface MemoryMutationRequest {
  characterId: CharacterId
  /** 谁拥有这条记忆（Memory Space 的界定者） */
  owner: EntityRef
  /**
   * 新建类操作用候选表达；对已存在记忆的操作用 `target` 表达。
   *
   * 两者**可以同时为空**（那就是一个空提案，放行口会拒绝它）。
   */
  candidates: readonly MemoryCandidate[]
  target?: MemoryMutationTarget
  /**
   * ============================================================================
   *  触发这次变更的**那条对话事件**（对已存在记忆的操作**必填**）
   * ============================================================================
   * 为什么它是必填而不是"从 target 推导"：
   *
   * `character_domain_events.primary_source_event_id` 是 **NOT NULL**
   * （迁移 0002），而计划书第 5 节的铁律是"没有来源的变化不允许落库"。
   * 对已存在记忆的变更是**由某句话触发的**：
   *
   *     "之前那个改一下，我现在能吃香菜了"
   *        ↓
   *     MEMORY_SUPERSEDED
   *
   * 那句用户话就是这次变化的来源。少了它，`SUPERSEDED` 会是一条
   * **没有来源的领域事件** —— 审计链在第二跳就断了，而且断得静默。
   *
   * ⚠️ 这也顺带修正了幂等键的一个缺陷：`create` 用候选的证据区间，
   * 而状态变更的事件区间**就是这一次对话**。若把区间写成 0（第一版的做法），
   * 那么"同一目标 + 同一操作"在不同轮次会被判成同一个幂等键，
   * 第二次操作会被静默丢弃 —— 与审计 §6 F4 那个缺陷是同一个形状。
   *
   * **创建类操作不需要它**：候选自己的证据就是来源。
   */
  triggeredByEventId?: string
  /** explicit = 用户明确要求；background = 后台自动发现（进 payload 与 trace） */
  mutation: 'explicit' | 'background'
  operation: MemoryMutationOperation
}

export interface MemoryRejection {
  code: string
  message: string
  /** 哪一条候选被拒（候选级拒绝时给出 proposedId） */
  candidateId?: string
}

export interface MemoryValidationOutcome {
  /** 全部候选/目标都通过才为 true（一个请求是一个工作单元） */
  accepted: AcceptedDomainEventMem[]
  rejected: MemoryRejection[]
  /** 放行口自己算出的、带 discriminator 的幂等键（审计 §6 F4） */
  idempotencyKeys: string[]
}

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface MemorySourceLookup {
  findEvents(
    ids: readonly string[]
  ): Promise<{ id: string; characterId: CharacterId; sequence: number }[]>
}

export interface MemoryProcessedStore {
  hasProcessed(idempotencyKey: string): Promise<boolean>
}

/**
 * 结构性重复检查所需的**最小读取口**（计划书第 75–76 节的去重第一、二层）。
 *
 * ============================================================================
 *  为什么它是只读的、且形状被刻意收窄
 * ============================================================================
 * 去重第一层（内容指纹完全相同 → `REJECT_DUPLICATE`）与第二层
 * （canonical key 命中 → 交给冲突分析）都必须**先看现在有什么**。
 * 若不给这个口，那两层就只能靠"落库时撞唯一索引"来实现 ——
 * 而那是一个**错误**，不是错误处理：
 *
 *   · 唯一索引拒掉一行会抛 `persistence_error`，
 *     调用方看到的是"数据库坏了"，而不是"这条已经记过了"
 *   · 计划书第 50 节要求 `REJECT` 是**正常结果**，不是异常
 *
 * 因此这里给的是"问两个问题"的能力，而不是一个通用的查询口 ——
 * 领域侧的放行口不该拿到 `MemoryStorePort` 的全部读能力
 * （那会让它有能力做"M5 的检索"，而这正是计划书第 88–90 节要分清的边界）。
 */
export interface MemoryLookupForPolicy {
  /** 内容指纹（含取值）完全相同且仍 ACTIVE 的那一条 */
  findActiveByFingerprint(input: {
    owner: EntityRef
    fingerprint: string
  }): Promise<{ memoryId: MemoryId } | undefined>
  /**
   * 同一事实槽位下仍 ACTIVE 的那些条（可能多条，原因见 `canonicalKeyOf` 的说明）。
   *
   * 用途是去重**第二层**的确定性半边：同一槽位 + 同一取值 → 重复。
   */
  findActiveByCanonicalKey(input: {
    owner: EntityRef
    canonicalKey: string
  }): Promise<{ memoryId: MemoryId }[]>
  /**
   * 取一条完整记录（可选）。
   *
   * 去重第二层需要拿既有记录的**取值**去比 slotFingerprint，
   * 而只给 `memoryId` 是比不了的。因此这里需要完整记录。
   *
   * ⚠️ 它**可选**：不提供时第二层的确定性半边不生效（只留第一层）。
   * 装配层应当提供它 —— 生产装配（`NativeMemoryStore`）天然满足。
   */
  getRecord?(memoryId: MemoryId): Promise<MemoryRecord | undefined>
}

export interface MemoryMutationValidatorDeps {
  registry: DomainEventRegistry
  sources: MemorySourceLookup
  processed: MemoryProcessedStore
  /**
   * 可选：提供它才会做去重第一、二层。
   *
   * **刻意可选**是为了不破坏既有调用点（M4 引入时验证脚本已经写好了），
   * 但生产装配**必须**传 —— 不传就等于没有去重第一层，
   * 而那正是 D2 追查发现的"重复 MEMORY_CREATED 事件"的来源。
   */
  lookup?: MemoryLookupForPolicy
  /**
   * 可选能力开关（M9.1 / ADR-072 D12）。
   *
   * `restatementRevivalEnabled`（环境变量 `CHARACTER_MEMORY_RESTATEMENT_ENABLED`，
   * 代码缺省 **false**）：**只**控制 create 路径的复活标记**发射**——
   *
   *   · off（缺省）：确定性 id 撞上 retracted/superseded 记录时照旧发射无标记的
   *     `MEMORY_CREATED`（折叠 no-op，与 M9 基线逐字节同形）；
   *   · on：满足 D03 四条件（既有记录状态 ∈ {retracted, superseded} + 开关开 +
   *     新证据与旧来源不相交）时发射**复活形**（带 `restatement` 标记 + 复活快照）。
   *
   * ⚠️ 它**不是**回滚开关：已提交的复活事件带标记，旧代码重放时 reducer 不读
   * 该字段 ⇒ no-op（发射侧半边）；存储侧 `appendDomainEvent` 原样落库（D07）。
   * reducer 的采纳分支**不受**此开关控制（标记在事件里，事件是事实）。
   */
  features?: {
    restatementRevivalEnabled?: boolean
  }
}

export interface MemoryMutationValidator {
  validate(request: MemoryMutationRequest): Promise<MemoryValidationOutcome>
}

// ---------------------------------------------------------------------------
// 操作映射
// ---------------------------------------------------------------------------

/** 六种意图各自产出什么领域事件 */
export function domainEventTypeFor(operation: MemoryMutationOperation): string {
  switch (operation) {
    case 'create':
      return MEMORY_CREATED
    case 'supersede':
      return MEMORY_SUPERSEDED
    case 'retract':
      return MEMORY_RETRACTED
    case 'dispute':
      return MEMORY_DISPUTED
    case 'restore':
      return MEMORY_RESTORED
    case 'merge':
      return MEMORY_MERGED
    default: {
      const exhaustive: never = operation
      throw new KernelError(
        'validation_error',
        'unknown_memory_operation',
        `未登记的 MemoryMutationOperation：${String(exhaustive)}`
      )
    }
  }
}

/**
 * `MemoryMutationOperation` → `ProposalOperation`。
 *
 * 计划书第 49 节的六个 `PolicyDecision` 里有 `MARK_DISPUTED`，
 * 而 `ProposalOperation` 原本没有对应值 —— M4 加了 `'dispute'`
 * （审计 §6 F3：它进幂等键，用 `update` 代替会让"标记争议"
 * 与"内容更新"在幂等层不可区分）。
 */
export function proposalOperationFor(operation: MemoryMutationOperation): string {
  switch (operation) {
    case 'create':
      return 'create'
    case 'supersede':
      return 'supersede'
    case 'retract':
      return 'retract'
    case 'dispute':
      return 'dispute'
    case 'restore':
      // `restore` 的语义是"把一条认知恢复到有效"，在通用词表里最接近 `update`。
      // 但**幂等键不用它**（见 idempotencyKeyForMemory 的 discriminator），
      // 因此这里的近似不会造成"两个不同操作撞键"。
      return 'update'
    case 'merge':
      return 'merge'
    default: {
      const exhaustive: never = operation
      throw new KernelError(
        'validation_error',
        'unknown_memory_operation',
        `未登记的 MemoryMutationOperation：${String(exhaustive)}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 幂等键（审计 §6 F4 的落地点）
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 *  Memory 的幂等键必须带 **discriminator**
 * ============================================================================
 * 形状：
 *
 *     characterId + processor + processorVersion
 *       + 源事件序号区间
 *       + `${operation}:${memoryId}`        ← discriminator
 *
 * `computeIdempotencyKey()` 的第五个分量是自由字符串，因此这里把
 * `operation` 与 `memoryId` 拼成它 —— **不改那个共用函数**。
 *
 * 两件事同时成立：
 *   · 同一批事件 + 同一 processor 版本 + 同一条事实重跑
 *     → 同一个 memoryId → 同一个键 → 幂等命中（不重复记）
 *   · 同一批里的不同候选
 *     → 不同 memoryId → 不同键 → 都能写入（这正是审计 §6 F4 修掉的缺陷）
 *
 * ⚠️ **序号区间仍然进键**：从 `[100,105]` 与 `[106,110]` 两批里
 * 抽到同一个槽位是**两次不同的操作**（对应两次不同的对话），
 * 后者应当能 supersede 前者。若只按 `(processor, memoryId)` 做键，
 * 第二次就会被当成"已经做过了"而静默跳过。
 */
export function idempotencyKeyForMemory(input: {
  characterId: CharacterId
  processor: string
  processorVersion: string
  sourceFromSequence: number
  sourceToSequence: number
  operation: MemoryMutationOperation
  memoryId: MemoryId
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: input.sourceFromSequence,
    sourceToSequence: input.sourceToSequence,
    operation: `${input.operation}:${String(input.memoryId)}`,
  })
}

/** 一条候选全部来源事件的序号区间（供幂等键与 trace 用） */
export function sourceRangeOf(
  found: readonly { id: string; sequence: number }[]
): { from: number; to: number } {
  if (found.length === 0) {
    throw new KernelError(
      'validation_error',
      'memory_without_source_range',
      '无法计算幂等键：候选没有任何可解析出序号来源事件'
    )
  }
  const sequences = found.map((e) => e.sequence)
  return { from: Math.min(...sequences), to: Math.max(...sequences) }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createMemoryMutationValidator(
  deps: MemoryMutationValidatorDeps
): MemoryMutationValidator {
  return {
    async validate(request: MemoryMutationRequest): Promise<MemoryValidationOutcome> {
      const rejected: MemoryRejection[] = []

      // --- 0. 空请求：拒绝而不是"成功但什么都没做" ------------------------
      // 计划书第 50 节要求 REJECT 是正常结果，但那指的是"这批对话不值得记"，
      // 不是"这个请求是空的"。空请求是**调用方的缺陷**，必须显式失败。
      if (request.candidates.length === 0 && request.target === undefined) {
        return {
          accepted: [],
          rejected: [
            {
              code: 'memory_mutation_empty',
              message:
                '既没有候选也没有目标：一个什么都不改的 Memory 变更请求应当由调用方丢弃，' +
                '而不是送进放行口并得到一个"成功"',
            },
          ],
          idempotencyKeys: [],
        }
      }

      // --- 1. owner 必须是 character（Memory Space 属于角色）-------------
      if (request.owner.kind !== 'character') {
        return {
          accepted: [],
          rejected: [
            {
              code: 'memory_owner_not_character',
              message: `Memory 的 owner 必须是 character，收到 ${request.owner.kind}:${String(request.owner.id)}`,
            },
          ],
          idempotencyKeys: [],
        }
      }

      const eventType = domainEventTypeFor(request.operation)

      // --- 2. 已存在记忆类操作：目标必须合法、来源必须给出 ------------------
      if (request.operation !== 'create') {
        if (request.target === undefined) {
          return {
            accepted: [],
            rejected: [
              {
                code: 'memory_target_missing',
                message: `${request.operation} 必须给出 target.memoryId —— ` +
                  '对一条不知道是哪条的记忆做变更，等于对整个 Memory Store 做一次模糊搜索（计划书第 57 节明确禁止）',
              },
            ],
            idempotencyKeys: [],
          }
        }

        // 来源必须存在、必须属于这个角色。少了它，这条领域事件会是一条
        // **没有来源的变化**（`primary_source_event_id` NOT NULL 也会拦下它）。
        const triggerId = request.triggeredByEventId
        if (typeof triggerId !== 'string' || triggerId.trim() === '') {
          return {
            accepted: [],
            rejected: [
              {
                code: 'memory_mutation_without_source',
                message:
                  `${request.operation} 必须给出 triggeredByEventId（触发这次变更的那条对话事件）。` +
                  '对已存在记忆的变更也是**由某句话引起的**，少了它审计链在第二跳就断了 —— 而且是静默断的（计划书第 5 节）',
              },
            ],
            idempotencyKeys: [],
          }
        }

        let triggerRefs: { id: string; characterId: CharacterId; sequence: number }[]
        try {
          triggerRefs = await deps.sources.findEvents([triggerId])
        } catch (error) {
          throw new KernelError(
            'persistence_error',
            'memory_source_lookup_failed',
            `来源查询失败：${error instanceof Error ? error.message : String(error)}`
          )
        }
        const trigger = triggerRefs[0]
        if (trigger === undefined) {
          return {
            accepted: [],
            rejected: [
              {
                code: 'memory_evidence_event_missing',
                message: `触发事件不存在：${triggerId}（失败关闭：不许凭空写一条没有来源的状态变化）`,
              },
            ],
            idempotencyKeys: [],
          }
        }
        if (String(trigger.characterId) !== String(request.characterId)) {
          return {
            accepted: [],
            rejected: [
              {
                code: 'memory_evidence_event_foreign',
                message: `触发事件不属于角色 ${String(request.characterId)}：${triggerId}`,
              },
            ],
            idempotencyKeys: [],
          }
        }

        const targetIssue = validateTarget(request)
        if (targetIssue !== undefined) {
          return { accepted: [], rejected: [targetIssue], idempotencyKeys: [] }
        }

        // 已存在记忆类操作**不需要新证据**：它们不建立新认知，
        // 只是改变一条已有认知的状态（它的证据在创建时就已存下）。
        const payload = buildTargetPayload(request)
        return finishSingle({
          deps,
          request,
          eventType,
          memoryId: request.target.memoryId,
          payload,
          sourceConversationEventIds: [triggerId],
          fromSequence: trigger.sequence,
          toSequence: trigger.sequence,
        })
      }

      // --- 3. create：逐条候选校验 ---------------------------------------
      const accepted: AcceptedDomainEventMem[] = []
      const idempotencyKeys: string[] = []

      for (const candidate of request.candidates) {
        const candidateId = String(candidate.proposedId)

        // 3.1 内容家族与记忆类型匹配（计划书第 16 / 20 节）
        try {
          assertContentMatchesType(candidate.proposedType, candidate.proposedContent)
        } catch (error) {
          rejected.push(toRejection(error, candidateId, 'content_type_mismatch'))
          continue
        }

        // 3.2 权威够不够建立这类记忆（计划书第 27 / 148 / 149 节）
        try {
          assertMemoryAuthorityAllows({
            authority: candidate.authority,
            type: candidate.proposedType,
            epistemicStatus: candidate.epistemicStatus,
          })
        } catch (error) {
          rejected.push(toRejection(error, candidateId, 'authority_not_allowed'))
          continue
        }

        // 3.3 证据与根（MI-03 / 计划书第 40–41 节）
        try {
          assertMemoryEvidence({
            sourceRefs: candidate.sourceRefs,
            evidenceRootIds: candidate.evidenceRootIds,
          })
        } catch (error) {
          rejected.push(toRejection(error, candidateId, 'evidence_invalid'))
          continue
        }

        // 3.4 来源事件必须真实存在且属于这个角色（与诊断链路同一条检查）
        //     计划书第 126 / 154 节：Evidence 必须指向**真实**事件，
        //     否则"这条记忆来自哪"就只是一句声称。
        const conversationRefs = candidate.sourceRefs.filter(
          (ref) => ref.kind === 'conversation_event'
        )
        let from = 0
        let to = 0
        if (conversationRefs.length > 0) {
          let found: { id: string; characterId: CharacterId; sequence: number }[]
          try {
            found = await deps.sources.findEvents(conversationRefs.map((ref) => ref.id))
          } catch (error) {
            throw new KernelError(
              'persistence_error',
              'memory_source_lookup_failed',
              `来源查询失败，无法确认证据是否存在：${
                error instanceof Error ? error.message : String(error)
              }`
            )
          }

          const foundById = new Map(found.map((e) => [String(e.id), e]))
          const missing = conversationRefs
            .map((ref) => ref.id)
            .filter((id) => !foundById.has(String(id)))
          if (missing.length > 0) {
            rejected.push({
              code: 'memory_evidence_event_missing',
              message:
                `证据事件不存在：${missing.join(', ')}（失败关闭：不忽略、不续写 —— ` +
                '一条引用不存在事件的记忆无法被审计）',
              candidateId,
            })
            continue
          }

          const foreign = found.filter(
            (e) => String(e.characterId) !== String(request.characterId)
          )
          if (foreign.length > 0) {
            rejected.push({
              code: 'memory_evidence_event_foreign',
              message: `证据事件不属于角色 ${String(request.characterId)}：${foreign
                .map((e) => String(e.id))
                .join(', ')}`,
              candidateId,
            })
            continue
          }

          const range = sourceRangeOf(found)
          from = range.from
          to = range.to
        }

        // 3.5 构造内容指纹，并做**去重第一层**（计划书第 75 节）
        //
        //     完全相同 → REJECT_DUPLICATE
        //
        // 这是"正常结果"而不是异常：重复陈述同一件事是真实对话里最常见的现象
        // （M4-004 场景：同一句"我不吃香菜"说三次）。
        // 若把它留给落库时的唯一索引，调用方看到的是 `persistence_error` ——
        // 那会让"已经记过了"看起来像"数据库坏了"。
        const fingerprint = contentFingerprintOf({
          owner: candidate.owner,
          type: candidate.proposedType,
          content: candidate.proposedContent,
          subjects: candidate.subjects,
        })

        if (deps.lookup !== undefined) {
          const duplicate = await deps.lookup.findActiveByFingerprint({
            owner: candidate.owner,
            fingerprint,
          })
          if (duplicate !== undefined) {
            rejected.push({
              code: 'duplicate_content',
              message:
                `内容与已有记忆完全相同（fingerprint ${fingerprint}），判定为重复陈述：` +
                `已有 ${String(duplicate.memoryId)}。计划书第 75 节的去重第一层在此拦下它 —— ` +
                '重复陈述是正常现象，不是新记忆',
              candidateId,
            })
            continue
          }
        }

        const canonicalKey = canonicalKeyOf({
          owner: candidate.owner,
          type: candidate.proposedType,
          content: candidate.proposedContent,
        })

        /*
         * 3.5b **去重第二层的确定性半边**（计划书第 76 节）
         *
         *     同一槽位（canonicalKey）+ 同一个取值 → DUPLICATE
         *
         * 它与 3.5 的区别：
         *   · 3.5 抓"这条记忆一模一样"（含 qualifiers 与 subjects 的全部内容）
         *   · 本步抓"同一个槽位上，用户说的是同一个值"
         *
         * 为什么需要本步：两条记忆可以**内容不同**（qualifiers 写法略有差别）
         * 但指向同一个槽位的同一个取值。第一层抓不到它们，
         * 而那会让"他第三次说他不吃香菜"在库里留下第三条 ——
         * 计划书第 177 节（M4-004）明确要求"最终不应该有三条 Active Memory"。
         *
         * ⚠️ 本步**只**拦"同一槽位 + 同一取值"。
         * 取值**不同**的必须留给上层做冲突分析（第 79–82 节）：
         * 那可能是 temporal update（旧条 supersede），也可能是
         * contradiction（进 DISPUTED），而那是两件不同的事。
         * 在这里拦掉它们会把"他改主意了"读成"他又说了一遍"。
         */
        if (deps.lookup !== undefined && canonicalKey !== undefined && isClaimContent(candidate.proposedContent)) {
          const slotFingerprint = slotFingerprintOf({
            canonicalKey,
            value: candidate.proposedContent.value,
          })
          const inSlot = await deps.lookup.findActiveByCanonicalKey({
            owner: candidate.owner,
            canonicalKey,
          })
          for (const existing of inSlot) {
            const existingRecord = await deps.lookup.getRecord?.(existing.memoryId)
            if (existingRecord === undefined) continue
            const existingSlot = slotOfRecord(existingRecord)
            if (existingSlot?.slotFingerprint !== slotFingerprint) continue

            rejected.push({
              code: 'duplicate_canonical',
              message:
                `同一事实槽位（${canonicalKey}）上已有**相同取值**的记忆 ` +
                `${String(existing.memoryId)}（slotFingerprint ${slotFingerprint}）。` +
                '计划书第 76 节的去重第二层在此拦下它 —— 重复陈述是正常现象，不是新记忆',
              candidateId,
            })
            break
          }
          if (rejected.some((r) => r.candidateId === candidateId && r.code === 'duplicate_canonical')) {
            continue
          }
        }

        /*
         * 3.5c **复活形发射判定**（M9.1 / ADR-072 D03——F-4 的修复点）
         *
         * 确定性 id（`makeMemoryId`：同 owner+type+subjects+content ⇒ 同 id）撞上
         * **既有记录**且其状态 ∈ {retracted, superseded} 时，这不是"重复陈述"
         * （两层去重只看 ACTIVE，拦不住它），而是「忘掉/更正后**新的合格重述**」：
         * 按用户裁定（R-21），它应当**复活**该槽位。
         *
         * 发射四条件（全满足才发复活形；否则照旧发无标记 CREATE）：
         *   ① 既有记录状态 ∈ {retracted, superseded}（DISPUTED 不自动复活——D10；
         *      ACTIVE 在 3.5/3.5b 已被拦下，到不了这里）；
         *   ② 开关 `features.restatementRevivalEnabled`（D12，缺省 false）；
         *   ③ 新证据与旧来源**不相交**（R06：同一句旧话重放不是"新的告知"，
         *      复活必须由**新的陈述行为**支撑）；
         *   ④ `getRecord` 可用（生产装配天然满足；不满足 = 无从判定，失败关闭）。
         *
         * 复活快照（D04）由 `revivalRecordFromCandidate` 构造：revision = 既有 +1，
         * 其余字段全部来自**新告知**（新来源、validFrom=now——不伪造连续有效期）。
         */
        let restatement: { previousRevision: number; previousStatus: 'retracted' | 'superseded' } | undefined
        let revivalPreviousRevision: number | undefined
        if (
          deps.features?.restatementRevivalEnabled === true &&
          deps.lookup?.getRecord !== undefined
        ) {
          const existing = await deps.lookup.getRecord(candidate.proposedId)
          if (
            existing !== undefined &&
            (existing.status === 'retracted' || existing.status === 'superseded')
          ) {
            const oldEvidence = new Set(existing.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`))
            const evidenceDisjoint = candidate.sourceRefs.every(
              (ref) => !oldEvidence.has(`${ref.kind}:${ref.id}`)
            )
            if (evidenceDisjoint) {
              restatement = {
                previousRevision: existing.revision,
                previousStatus: existing.status,
              }
              revivalPreviousRevision = existing.revision
            }
          }
        }

        // 3.6 构造首版快照并走 registry 校验 payload 契约
        //
        //     复活形（3.5c 命中）：用复活快照（revision = 既有 +1，
        //     validFrom = 本次告知时刻——见 `revivalRecordFromCandidate` 的说明）。
        const record =
          revivalPreviousRevision !== undefined
            ? revivalRecordFromCandidate({
                candidate: { ...candidate, proposedValidFrom: Date.now() },
                content: candidate.proposedContent,
                ...(canonicalKey !== undefined ? { canonicalKey } : {}),
                recordedAt: Date.now(),
                previousRevision: revivalPreviousRevision,
              })
            : recordFromCandidate({
                candidate,
                content: candidate.proposedContent,
                ...(canonicalKey !== undefined ? { canonicalKey } : {}),
                recordedAt: Date.now(),
              })

        // 3.6 payload 契约 + 上限（复用 registry，与诊断链路同一处）
        const spec = deps.registry.get(eventType)
        if (spec === undefined) {
          return {
            accepted: [],
            rejected: [
              {
                code: 'domain_event_type_unregistered',
                message: `${eventType} 未在 DomainEventRegistry 登记，无法确定 payload 契约`,
              },
            ],
            idempotencyKeys: [],
          }
        }

        let payload: unknown
        try {
          payload = spec.validatePayload({
            memoryId: String(candidate.proposedId),
            record,
            mutation: request.mutation,
            ...(restatement !== undefined ? { restatement } : {}),
          })
        } catch (error) {
          rejected.push(toRejection(error, candidateId, 'payload_schema_invalid'))
          continue
        }

        const bytes = byteLength(JSON.stringify(payload))
        if (bytes > spec.maxPayloadBytes) {
          rejected.push({
            code: 'payload_too_large',
            message: `payload ${bytes} 字节超过上限 ${spec.maxPayloadBytes}（计划书第 21 节的 payload 上限）`,
            candidateId,
          })
          continue
        }

        // 3.7 scope 必须仍是 CHARACTER_INTERNAL（M3.5 的 FC-04）
        const scope: DomainEventScope = DOMAIN_EVENT_SCOPE
        try {
          assertCharacterInternalScope(scope)
        } catch (error) {
          rejected.push(toRejection(error, candidateId, 'domain_event_scope_invalid'))
          continue
        }

        // 3.8 幂等键（**带 memoryId discriminator**）
        const idempotencyKey = idempotencyKeyForMemory({
          characterId: request.characterId,
          processor: candidate.processor,
          processorVersion: candidate.processorVersion,
          sourceFromSequence: from,
          sourceToSequence: to,
          operation: 'create',
          memoryId: candidate.proposedId,
        })

        if (await deps.processed.hasProcessed(idempotencyKey)) {
          rejected.push({
            code: 'duplicate_operation',
            message:
              `幂等键 ${idempotencyKey} 已处理过：同一条事实在**同一段证据区间**` +
              '只允许建立一次（重跑是安静的成功，不是新操作）',
            candidateId,
          })
          continue
        }

        accepted.push({
          type: eventType,
          operation: proposalOperationFor('create'),
          payload,
          sourceConversationEventIds: conversationRefs.map((ref) => ref.id) as never,
          idempotencyKey,
          processor: candidate.processor,
          processorVersion: candidate.processorVersion,
          scope,
        })
        idempotencyKeys.push(idempotencyKey)
      }

      return { accepted, rejected, idempotencyKeys }
    },
  }
}

// ---------------------------------------------------------------------------
// 已存在记忆类操作
// ---------------------------------------------------------------------------

function validateTarget(request: MemoryMutationRequest): MemoryRejection | undefined {
  const target = request.target!
  if (String(target.memoryId).trim() === '') {
    return { code: 'memory_target_missing', message: 'target.memoryId 为空' }
  }

  switch (request.operation) {
    case 'supersede':
      if (target.supersededBy === undefined) {
        return {
          code: 'memory_supersede_without_replacement',
          message:
            'supersede 必须给出 target.supersededBy：' +
            '计划书第 35 / 84 节的 SUPERSEDED 表示"有更适合描述当前情况的新记忆"，' +
            '没有新条就只是 retract',
        }
      }
      if (String(target.supersededBy) === String(target.memoryId)) {
        return {
          code: 'memory_supersede_self',
          message: 'supersede 不能指向自己：那会让 supersededBy 形成自环，重放时无法收敛',
        }
      }
      if (target.validUntil !== undefined && !Number.isFinite(target.validUntil)) {
        return {
          code: 'bad_valid_until',
          message: `target.validUntil 必须是有限时间戳，收到 ${String(target.validUntil)}`,
        }
      }
      return undefined

    case 'retract': {
      const allowed = ['explicit_forget', 'explicit_correction', 'audit']
      if (target.reason === undefined || !allowed.includes(target.reason)) {
        return {
          code: 'memory_retract_reason_invalid',
          message:
            `retract 的 reason 必须是 ${allowed.join(' / ')}（计划书第 58–59 节：` +
            '认知遗忘与数据删除是两种操作，必须可区分），收到 ' + String(target.reason),
        }
      }
      return undefined
    }

    case 'dispute':
      // 计划书第 82 节：判不了就标记争议。conflictingMemoryIds 允许为空
      // （矛盾的对侧可能还没进库）。
      if (typeof target.reason !== 'string' || target.reason.trim() === '') {
        return {
          code: 'memory_dispute_without_reason',
          message:
            'dispute 必须给出 reason：计划书第 33 节要求能回答"为什么它进不了判断"，' +
            '否则半年后没人知道当年的矛盾是什么',
        }
      }
      return undefined

    case 'restore':
      if (typeof target.reason !== 'string' || target.reason.trim() === '') {
        return {
          code: 'memory_restore_without_reason',
          message: 'restore 必须给出 reason：恢复一条曾被推翻的记忆是一个需要解释的动作',
        }
      }
      return undefined

    case 'merge':
      if (target.winnerId === undefined) {
        return { code: 'memory_merge_without_winner', message: 'merge 必须给出 winnerId' }
      }
      if (!Array.isArray(target.loserIds) || target.loserIds.length === 0) {
        return {
          code: 'memory_merge_without_loser',
          message: 'merge 必须至少有一个 loser —— 没有败者的"合并"其实是创建（见 payload 校验）',
        }
      }
      return undefined

    default:
      return undefined
  }
}

function buildTargetPayload(request: MemoryMutationRequest): unknown {
  const target = request.target!
  switch (request.operation) {
    case 'supersede':
      return {
        memoryId: String(target.memoryId),
        supersededBy: String(target.supersededBy!),
        validUntil: target.validUntil ?? Date.now(),
        reason: target.reason ?? '被新状态取代',
      }
    case 'retract':
      return {
        memoryId: String(target.memoryId),
        reason: target.reason,
        ...(target.note !== undefined ? { note: target.note } : {}),
      }
    case 'dispute':
      return {
        memoryId: String(target.memoryId),
        conflictingMemoryIds: (target.conflictingMemoryIds ?? []).map(String),
        reason: target.reason,
      }
    case 'restore':
      return { memoryId: String(target.memoryId), reason: target.reason }
    case 'merge':
      return {
        winnerId: String(target.winnerId!),
        loserIds: (target.loserIds ?? []).map(String),
        reason: target.reason ?? '同义合并',
      }
    default:
      throw new KernelError(
        'validation_error',
        'unknown_memory_operation',
        `未登记的 MemoryMutationOperation：${String(request.operation)}`
      )
  }
}

async function finishSingle(input: {
  deps: MemoryMutationValidatorDeps
  request: MemoryMutationRequest
  eventType: string
  memoryId: MemoryId
  payload: unknown
  sourceConversationEventIds: string[]
  fromSequence: number
  toSequence: number
}): Promise<MemoryValidationOutcome> {
  const spec = input.deps.registry.get(input.eventType)
  if (spec === undefined) {
    return {
      accepted: [],
      rejected: [
        {
          code: 'domain_event_type_unregistered',
          message: `${input.eventType} 未在 DomainEventRegistry 登记`,
        },
      ],
      idempotencyKeys: [],
    }
  }

  let payload: unknown
  try {
    payload = spec.validatePayload(input.payload)
  } catch (error) {
    return {
      accepted: [],
      rejected: [toRejection(error, undefined, 'payload_schema_invalid')],
      idempotencyKeys: [],
    }
  }

  const idempotencyKey = idempotencyKeyForMemory({
    characterId: input.request.characterId,
    processor: 'memory-mutation',
    processorVersion: 'memory-mutation@1',
    sourceFromSequence: input.fromSequence,
    sourceToSequence: input.toSequence,
    operation: input.request.operation,
    memoryId: input.memoryId,
  })

  if (await input.deps.processed.hasProcessed(idempotencyKey)) {
    return {
      accepted: [],
      rejected: [
        {
          code: 'duplicate_operation',
          message: `幂等键 ${idempotencyKey} 已处理过：同一条记忆的同一个操作只允许生效一次`,
        },
      ],
      idempotencyKeys: [idempotencyKey],
    }
  }

  return {
    accepted: [
      {
        type: input.eventType,
        operation: proposalOperationFor(input.request.operation),
        payload,
        sourceConversationEventIds: input.sourceConversationEventIds as never,
        idempotencyKey,
        processor: 'memory-mutation',
        processorVersion: 'memory-mutation@1',
        scope: DOMAIN_EVENT_SCOPE,
      },
    ],
    rejected: [],
    idempotencyKeys: [idempotencyKey],
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function toRejection(
  error: unknown,
  candidateId: string | undefined,
  fallbackCode: string
): MemoryRejection {
  const code =
    error instanceof KernelError
      ? error.code
      : typeof (error as { code?: unknown })?.code === 'string'
        ? String((error as { code: string }).code)
        : fallbackCode
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(candidateId !== undefined ? { candidateId } : {}),
  }
}

/** UTF-8 字节数（与 `validator.ts` 同一个不引 Buffer 的换算） */
function byteLength(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 放行口的产物与 `DomainPolicyValidator` 的 `AcceptedDomainEvent` **同形**。
 *
 * 刻意不发明第二种形状：`applyAcceptedEvents()` 接受的是那个类型，
 * 而"MEMORY_* 与其它领域事件走同一条落库路径"是这个设计的前提
 * （计划书第 71 节禁止绕过事件）。
 */
export type AcceptedDomainEventMem = AcceptedDomainEvent
