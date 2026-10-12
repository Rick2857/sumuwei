/**
 * DomainPolicyValidator —— **唯一放行口**。
 *
 * ============================================================================
 *  Validator 必须失败关闭（fail closed）
 * ============================================================================
 * 最典型的一条：提案引用了**不存在的 source_event_id**。
 *
 *   错误做法：忽略 source，然后继续写 Domain Event
 *   正确做法：reject
 *
 * 因为 provenance（可追溯性）是整个项目的地基。一旦允许"来源不明的变化"
 * 落库，plan 第 5 节那条审计链（Domain Event → Conversation Event → 那次对话）
 * 就断了，而且是**静默**断掉的——这比直接报错危险得多。
 *
 * M2.5 的 Validator 严格实现 plan 第 21 节列的八项检查：
 *   Schema / Character Ownership / Source 存在性 / Source 归属 /
 *   Processor 版本存在 / 幂等 / payload 上限 / Domain Event 类型 allowlist
 *
 * 未来 M4–M11 再加：confidence 阈值、证据权威级别、Seed 保护、
 * 关系变化幅度上限、Belief 冲突处理。这些**全部加在这里**，
 * 不许各 Processor 自己判断。
 */

import {
  DOMAIN_EVENT_SCOPE,
  KernelError,
  REGISTERED_DOMAIN_EVENT_TYPES,
  assertCharacterInternalScope,
  idempotencyKeyFor,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
  type DomainEventRegistry,
  type DomainEventScope,
  type DomainProposal,
  type ProposedDomainEvent,
} from '../contracts/index.ts'

/** 校验通过后的一个待写入领域事件（仍无 id / sequence / 幂等键已定） */
export interface AcceptedDomainEvent {
  type: string
  operation: string
  payload: unknown
  sourceConversationEventIds: ConversationEventId[]
  idempotencyKey: string
  processor: string
  processorVersion: string
  /**
   * M3.5：已被 Validator 校验过的范围（必为 `CHARACTER_INTERNAL`）。
   *
   * 它出现在这里而不是"由写入方自己填"，是因为**放行口必须记录它放行了什么**
   * —— 否则"这条记录为什么是角色内部的"就只能靠读代码回答。
   */
  scope: DomainEventScope
  /** M3.5：发生时间（Processor 可选提供） */
  occurredAt?: number
  /** M3.5：模拟时间槽位（当前必为空） */
  logicalTime?: string
  /**
   * **M11（ADR-085 `D25`）**：这条事件派生自哪些**已提交**的领域事件。
   *
   * 由 Validator 在放行时**校验并记录**（与 `scope` 同一个理由：放行口要记录它放行了什么）。
   * 缺省 = 旧调用者的形状 ⇒ `event-store` 写 `null`。
   */
  causedByDomainEventIds?: DomainEventId[]
}

export interface RejectedTarget {
  type: string
  code: string
  message: string
}

export interface ValidatorOutcome {
  proposalId: string
  characterId: CharacterId
  /** 全部 target 都通过才为 true（提案是一个整体工作单元） */
  accepted: boolean
  acceptedEvents: AcceptedDomainEvent[]
  rejected: RejectedTarget[]
}

export interface ProposalSourceLookup {
  /**
   * 取一批对话事件的最小信息。
   *
   * 只要求 (id, characterId) 与 shape 是否存在——Validator 不需要正文。
   * 这样它不会因为"读到聊天内容"而承担额外责任，也更容易测。
   */
  findEvents(
    ids: readonly ConversationEventId[]
  ): Promise<{ id: ConversationEventId; characterId: CharacterId; sequence: number }[]>
}

export interface ProcessedOperationStore {
  /** 该幂等键是否已经成功处理过 */
  hasProcessed(idempotencyKey: string): Promise<boolean>
}

/**
 * **M11（ADR-085 `D25`）**：派生链的父事件只读查询口。
 *
 * 只要求 `(id, characterId, sequence)` —— Validator 不需要正文，因此它不会因为
 * "读到别人的记忆内容"而承担额外责任（与 `ProposalSourceLookup` 同一口径）。
 *
 * ⚠️ **它是可选的，但"字段出现而口不在"= 拒绝**（`caused_by_lookup_unavailable`）：
 *    失败关闭。若允许"查不了就当没有"，派生链会在装配不完整时**静默消失**，
 *    而消失的后果不是报错，是 M11 的根计数**静默变松**。
 */
export interface DomainEventParentLookup {
  findByIds(
    ids: readonly DomainEventId[]
  ): Promise<{ id: DomainEventId; characterId: CharacterId; sequence: number }[]>
}

export interface ValidatorConfig {
  /** 允许的 Domain Event 类型；默认取 `REGISTERED_DOMAIN_EVENT_TYPES` */
  allowedDomainEventTypes?: readonly string[]
  /** 单条 payload 序列化后的上限（字节），用于兜底 registry 未声明的情况 */
  maxPayloadBytes?: number
}

export interface DomainPolicyValidatorDeps {
  registry: DomainEventRegistry
  sources: ProposalSourceLookup
  processed: ProcessedOperationStore
  /** M11 `D25`：派生链的父事件查询口（字段出现时必须提供，否则拒收） */
  parents?: DomainEventParentLookup
  config?: ValidatorConfig
}

export interface DomainPolicyValidator {
  validate(proposal: DomainProposal): Promise<ValidatorOutcome>
}

export function createDomainPolicyValidator(
  deps: DomainPolicyValidatorDeps
): DomainPolicyValidator {
  /*
   * allowlist 的来源优先级（M4 起）：
   *
   *   1. 显式传入的 `config.allowedDomainEventTypes`（测试用来构造"只允许一种"的场景）
   *   2. **注入的 registry 里实际登记的类型**
   *   3. `REGISTERED_DOMAIN_EVENT_TYPES`（M2.5 的默认表）
   *
   * ---------------------------------------------------------------------------
   *  ⚠️ 第 2 条是 M4 加的，它修正的是一个**只在"换 registry"时才暴露**的缺陷
   * ---------------------------------------------------------------------------
   * 在 M4 之前，registry 与 allowlist 是**同一个常量**的两处引用，
   * 因此"它们一致"是碰巧成立的。
   *
   * M4 让 `initKernel` 可以注入只含 `MEMORY_*` 的 registry 之后，
   * 若 allowlist 仍然硬取 `REGISTERED_DOMAIN_EVENT_TYPES`（只有诊断信号），
   * 那么每一个 Memory 提案都会被 `domain_event_type_not_allowed` 拒掉 ——
   * 而错误信息会说"不在允许的类型表内"，指向一个**与它无关**的常量。
   *
   * 这条缺陷不会在"只跑默认 registry"的既有测试里暴露，
   * 因此必须在这里修掉，而不是等某天有人困惑为什么 Memory 提案全被拒。
   *
   * 反过来，"未登记就拒绝"这条防线**不被削弱**：
   * registry 里没有的类型，`deps.registry.get(type)` 仍然返回 `undefined`，
   * 第 4 步的 `domain_event_type_unregistered` 照样拒它。
   */
  const allowed = new Set<string>(
    deps.config?.allowedDomainEventTypes ?? deps.registry.types()
  )
  if (allowed.size === 0) {
    // registry 是空表时不静默放行一切：回落到 M2.5 的默认表（失败关闭的方向）
    for (const type of REGISTERED_DOMAIN_EVENT_TYPES) allowed.add(type)
  }
  const fallbackMaxBytes = deps.config?.maxPayloadBytes ?? 4096

  return {
    async validate(proposal: DomainProposal): Promise<ValidatorOutcome> {
      const rejected: RejectedTarget[] = []

      // --- 1. 提案级结构检查 ---------------------------------------------
      if (proposal.processor.trim() === '' || proposal.processorVersion.trim() === '') {
        return {
          proposalId: proposal.proposalId,
          characterId: proposal.characterId,
          accepted: false,
          acceptedEvents: [],
          rejected: proposal.targetEvents.map((t) => ({
            type: t.type,
            code: 'processor_version_presence',
            message: '提案缺少 processor 或 processorVersion',
          })),
        }
      }

      // --- 2. 来源事件：存在性 + 归属 ------------------------------------
      const sourceIds = proposal.sourceConversationEventIds
      if (sourceIds.length === 0) {
        return {
          proposalId: proposal.proposalId,
          characterId: proposal.characterId,
          accepted: false,
          acceptedEvents: [],
          rejected: proposal.targetEvents.map((t) => ({
            type: t.type,
            code: 'source_event_missing',
            message: '提案没有引用任何来源对话事件；provenance 是整个项目的地基，不允许来源不明的变化',
          })),
        }
      }

      const found = await deps.sources.findEvents(sourceIds)
      const foundById = new Map(found.map((e) => [String(e.id), e]))

      const missing = sourceIds.filter((id) => !foundById.has(String(id)))
      if (missing.length > 0) {
        return {
          proposalId: proposal.proposalId,
          characterId: proposal.characterId,
          accepted: false,
          acceptedEvents: [],
          rejected: proposal.targetEvents.map((t) => ({
            type: t.type,
            code: 'source_event_missing',
            message: `来源对话事件不存在：${missing.join(', ')}（失败关闭：不忽略、不续写）`,
          })),
        }
      }

      const foreign = found.filter((e) => String(e.characterId) !== String(proposal.characterId))
      if (foreign.length > 0) {
        return {
          proposalId: proposal.proposalId,
          characterId: proposal.characterId,
          accepted: false,
          acceptedEvents: [],
          rejected: proposal.targetEvents.map((t) => ({
            type: t.type,
            code: 'source_event_foreign',
            message:
              `来源事件不属于角色 ${String(proposal.characterId)}：` +
              foreign.map((e) => `${String(e.id)} → ${String(e.characterId)}`).join(', '),
          })),
        }
      }

      // --- 3. 幂等键（唯一计算处）----------------------------------------
      let keys: string[]
      try {
        keys = idempotencyKeyFor(proposal)
      } catch (error) {
        return {
          proposalId: proposal.proposalId,
          characterId: proposal.characterId,
          accepted: false,
          acceptedEvents: [],
          rejected: proposal.targetEvents.map((t) => ({
            type: t.type,
            code: 'idempotency_key_failed',
            message: error instanceof Error ? error.message : String(error),
          })),
        }
      }

      // --- 4. 逐个 target 校验 -------------------------------------------
      const acceptedEvents: AcceptedDomainEvent[] = []

      for (let i = 0; i < proposal.targetEvents.length; i += 1) {
        const target = proposal.targetEvents[i]
        const idempotencyKey = keys[i]

        const spec = deps.registry.get(target.type)

        if (!allowed.has(target.type)) {
          rejected.push({
            type: target.type,
            code: 'domain_event_type_not_allowed',
            message: `${target.type} 不在允许的 Domain Event 类型表内（allowlist：${[...allowed].join(', ') || '(空)'}）`,
          })
          continue
        }
        if (!spec) {
          rejected.push({
            type: target.type,
            code: 'domain_event_type_unregistered',
            message: `${target.type} 未在 DomainEventRegistry 登记，无法确定 payload 契约`,
          })
          continue
        }

        let payload: unknown
        try {
          payload = spec.validatePayload(target.payload)
        } catch (error) {
          rejected.push({
            type: target.type,
            code: 'payload_schema_invalid',
            message: error instanceof Error ? error.message : String(error),
          })
          continue
        }

        const bytes = byteLength(JSON.stringify(payload))
        const limit = spec.maxPayloadBytes || fallbackMaxBytes
        if (bytes > limit) {
          rejected.push({
            type: target.type,
            code: 'payload_too_large',
            message: `payload ${bytes} 字节超过上限 ${limit}`,
          })
          continue
        }

        const duplicates = await resolveDuplicates(deps.processed, idempotencyKey)
        if (duplicates) {
          rejected.push({
            type: target.type,
            code: 'duplicate_operation',
            message: `幂等键 ${idempotencyKey} 已处理过：同一 (processor, version, 事件范围, 操作) 只允许生效一次`,
          })
          continue
        }

        /*
         * M11（ADR-085 `D25`）：派生链的**语义**检查。
         *
         * 放在幂等之后、scope 之前：与既有的"类型 → 来源 → payload → 幂等 → scope"
         * 顺序同构 —— scope 仍然**最后一道**（被拒的提案拿到最有信息量的码）。
         *
         * ⚠️ **环检测不在这里**：父事件必须**已存在** ⇒ 它的序号必然小于本次将要
         *    分配的序号 ⇒ 新加的边只向后指 ⇒ **新事件不可能制造环**。
         *    环只可能存在于**旧数据**里，那是 resolver 读时的职责（§4.4 / `D31`）。
         */
        const parentIds = target.causedByDomainEventIds
        if (parentIds !== undefined && parentIds.length > 0) {
          const verdict = await checkCausedBy(deps.parents, parentIds, proposal.characterId)
          if (verdict !== null) {
            rejected.push({ type: target.type, code: verdict.code, message: verdict.message })
            continue
          }
        }

        /*
         * M3.5（FC-04）：角色内部事件不得承担世界事实的职责。
         *
         * 放在**最后一道**（类型、来源、幂等都已通过之后）而不是最前面：
         * 这样被拒的 proposal 会得到最有信息量的那个拒绝码 ——
         * 一条同时"类型未登记 + 声称是 WORLD"的提案，
         * 先告诉它"类型未登记"比先说 scope 更有用。
         */
        const scope = target.scope ?? DOMAIN_EVENT_SCOPE
        try {
          assertCharacterInternalScope(scope)
        } catch (error) {
          rejected.push({
            type: target.type,
            code: error instanceof KernelError ? error.code : 'domain_event_scope_invalid',
            message: error instanceof Error ? error.message : String(error),
          })
          continue
        }

        acceptedEvents.push({
          type: target.type,
          operation: target.operation,
          payload,
          sourceConversationEventIds: [...sourceIds],
          idempotencyKey,
          processor: proposal.processor,
          processorVersion: proposal.processorVersion,
          scope,
          // M11 `D25`：只在校验通过后**原样**带上（缺省仍不写这个键 ⇒ 写入 null）
          ...(parentIds !== undefined && parentIds.length > 0
            ? { causedByDomainEventIds: [...parentIds] }
            : {}),
        })
      }

      const accepted = rejected.length === 0 && acceptedEvents.length > 0

      return {
        proposalId: proposal.proposalId,
        characterId: proposal.characterId,
        accepted,
        // 提案是整体：任一条被拒则全部不生效，避免"半个提案"进库
        acceptedEvents: accepted ? acceptedEvents : [],
        rejected,
      }
    },
  }
}

/** 幂等查询失败不允许静默放过：查不了就当"没处理过"是危险的 */
async function resolveDuplicates(  store: ProcessedOperationStore,
  key: string
): Promise<boolean> {
  try {
    return await store.hasProcessed(key)
  } catch (error) {
    throw new KernelError(
      'persistence_error',
      'idempotency_lookup_failed',
      `幂等查询失败，无法确认操作是否已执行：${error instanceof Error ? error.message : String(error)}`,
      { idempotencyKey: key }
    )
  }
}

/**
 * **M11（ADR-085 `D25`）**：派生链的语义检查（父事件必须已存在且同角色）。
 *
 * 返回 `null` = 通过；返回 `{code, message}` = 该 target 被拒。
 * 查询口缺失或查询失败 ⇒ **失败关闭**（拒收 / 抛出），绝不"当作没有派生"。
 *
 * 为什么"已存在"就足以证明"早于本事件"：新事件的序号由 `allocateSequence()`
 * 在**写入时**分配，必然大于表里已有的任何序号 ⇒ 已存在的父事件天然早于它。
 */
async function checkCausedBy(
  lookup: DomainEventParentLookup | undefined,
  ids: readonly DomainEventId[],
  characterId: CharacterId
): Promise<{ code: string; message: string } | null> {
  if (lookup === undefined) {
    return {
      code: 'caused_by_lookup_unavailable',
      message:
        '提案带了 causedByDomainEventIds，但装配层没有提供 DomainEventParentLookup —— 查不了就拒收（失败关闭）',
    }
  }
  let found: { id: DomainEventId; characterId: CharacterId; sequence: number }[]
  try {
    found = await lookup.findByIds(ids)
  } catch (error) {
    throw new KernelError(
      'persistence_error',
      'caused_by_lookup_failed',
      `派生链父事件查询失败，无法确认来源是否成立：${error instanceof Error ? error.message : String(error)}`,
      { causedByDomainEventIds: [...ids] }
    )
  }
  const byId = new Map(found.map((row) => [String(row.id), row]))
  for (const id of ids) {
    const row = byId.get(String(id))
    if (row === undefined) {
      return {
        code: 'caused_by_parent_missing',
        message: `派生链引用了不存在的父事件 ${String(id)}（无法追溯的来源不可用于采纳，且不许猜父事件）`,
      }
    }
    if (String(row.characterId) !== String(characterId)) {
      return {
        code: 'caused_by_parent_foreign',
        message: `派生链的父事件 ${String(id)} 属于别的角色（${String(row.characterId)}）`,
      }
    }
    if (!Number.isInteger(row.sequence) || row.sequence <= 0) {
      return {
        code: 'caused_by_parent_invalid',
        message: `派生链的父事件 ${String(id)} 没有合法序号（${String(row.sequence)}）`,
      }
    }
  }
  return null
}

function byteLength(text: string): number {
  // 不引 Buffer（领域层不依赖 node 内置对象）：UTF-8 字节数的确定性换算
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
 * 校验失败时给出**可诊断**的错误（测试与排错都靠它）。
 *
 * 不用 `assert(outcome.accepted)` 那种写法：那样失败信息只有一句 false，
 * 而这里会把每条 code/message 都带出来。
 */
export function assertValidatorAccepted(outcome: ValidatorOutcome): AcceptedDomainEvent[] {
  if (!outcome.accepted) {
    const detail = outcome.rejected.map((r) => `${r.code}: ${r.message}`).join('; ')
    throw new KernelError(
      'validation_error',
      'proposal_rejected',
      `提案 ${outcome.proposalId} 未被接受 —— ${detail}`,
      { proposalId: outcome.proposalId, rejected: outcome.rejected }
    )
  }
  return outcome.acceptedEvents
}

/** 便捷判定：这批 target 里有没有被拒的（用于断言"期望被拒"的测试） */
export function rejectionCodes(outcome: ValidatorOutcome): string[] {
  return outcome.rejected.map((r) => r.code)
}

export type { ProposedDomainEvent }
