/**
 * 单轮执行的原始结果与不变量断言。
 *
 * ============================================================================
 *  为什么把"断言"和"运行"分开
 * ============================================================================
 * 一个场景跑完会留下很多**事实**（用了哪些 section、写了哪些事件、
 * 投影前进了多少）。这些事实既可以被场景自己的断言读，也可以被
 * `assertInvariants()` 无条件检查一遍——后者是"跨场景恒真"的那部分：
 * 无论场景测什么，来源隔离、序号单调、投影可重放这些都不许破。
 *
 * 于是新增场景时不需要重复写这些不变量，也不会漏检。
 */

import {
  DIAGNOSTIC_SIGNAL,
  type CharacterId,
  type ConversationEvent,
  type DomainEvent,
} from '../../src/kernel/contracts/index.ts'
import type { ContextPacket } from '../../src/kernel/contracts/index.ts'

/** 一次执行的原始记录（由 runner 填充，断言只读） */
export interface ScenarioRun {
  scenarioId: string
  characterId: CharacterId

  /** 每一轮的模型输入（= ContextPacket 渲染出的 prompt） */
  prompts: string[]
  /** 每一轮进入模型的 section */
  packets: ContextPacket[]

  /** 全部对话事件（按写入顺序） */
  conversationEvents: ConversationEvent[]
  /** 全部领域事件 */
  domainEvents: DomainEvent[]

  /** 每一轮助手回复的文本 */
  replies: string[]

  /** 投影 revision 快照（每轮结束后） */
  projectionRevisions: number[]

  /** 人为制造的故障记录（如"模型抛错""Phoenix 离线"） */
  injectedFailures: string[]

  /** 运行耗时（毫秒） */
  durationMs: number
}

export interface InvariantViolation {
  code: string
  message: string
}

/**
 * 跨场景恒真的不变量。
 *
 * 这些检查**故意写得很啰嗦**：它们失败时必须能直接看懂哪里破了，
 * 而不是抛出一句 `expected false to be true`。
 */
export function assertInvariants(run: ScenarioRun): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const push = (code: string, message: string) => violations.push({ code, message })

  // --- 1. 来源隔离（铁律 5 / SC-002）-------------------------------------
  for (const event of run.conversationEvents) {
    if (event.type === 'user_message' && event.actorType !== 'user') {
      push(
        'source_separation',
        `事件 ${event.id} 声称是用户消息，actorType 却是 ${event.actorType}`
      )
    }
    if (event.type === 'assistant_message' && event.actorType !== 'character') {
      push(
        'source_separation',
        `事件 ${event.id} 声称是角色回复，actorType 却是 ${event.actorType}`
      )
    }
  }

  // --- 2. 序号单调且唯一（SC-003）----------------------------------------
  const sequences = run.conversationEvents.map((e) => e.sequence)
  const unique = new Set(sequences)
  if (unique.size !== sequences.length) {
    push('sequence_unique', `对话事件序号出现重复：${sequences.join(',')}`)
  }
  for (let i = 1; i < sequences.length; i += 1) {
    if (sequences[i] <= sequences[i - 1]) {
      push(
        'sequence_monotonic',
        `对话事件序号不是严格递增：#${sequences[i - 1]} → #${sequences[i]}`
      )
      break
    }
  }

  const domainSequences = run.domainEvents.map((e) => e.sequence)
  const domainUnique = new Set(domainSequences)
  if (domainUnique.size !== domainSequences.length) {
    push('domain_sequence_unique', `领域事件序号出现重复：${domainSequences.join(',')}`)
  }

  // --- 3. 每个领域事件都能溯源（铁律 8）----------------------------------
  const knownEventIds = new Set(run.conversationEvents.map((e) => String(e.id)))
  for (const event of run.domainEvents) {
    if (event.sourceConversationEventIds.length === 0) {
      push('provenance', `领域事件 ${event.id} 没有任何来源对话事件`)
      continue
    }
    for (const sourceId of event.sourceConversationEventIds) {
      if (!knownEventIds.has(String(sourceId))) {
        push('provenance', `领域事件 ${event.id} 引用了不存在的来源 ${String(sourceId)}`)
      }
    }
  }

  // --- 4. 幂等键唯一（铁律 10 / SC-004）----------------------------------
  const keys = run.domainEvents.map((e) => e.idempotencyKey)
  if (new Set(keys).size !== keys.length) {
    push('idempotency', `出现了重复的幂等键：${keys.join(',')}`)
  }

  // --- 5. 诊断链路只由用户证据触发（铁律 5）------------------------------
  const verified = new Set(
    run.domainEvents
      .filter((e) => e.type === DIAGNOSTIC_SIGNAL)
      .flatMap((e) => e.sourceConversationEventIds.map(String))
  )
  for (const sourceId of verified) {
    const source = run.conversationEvents.find((e) => String(e.id) === sourceId)
    if (source && source.actorType !== 'user') {
      push(
        'evidence_authority',
        `诊断信号引用了非用户来源 ${sourceId}（actorType=${source.actorType}）`
      )
    }
  }

  // --- 6. 投影版本只增不减（铁律 9）--------------------------------------
  for (let i = 1; i < run.projectionRevisions.length; i += 1) {
    if (run.projectionRevisions[i] < run.projectionRevisions[i - 1]) {
      push(
        'projection_monotonic',
        `投影 revision 回退：${run.projectionRevisions[i - 1]} → ${run.projectionRevisions[i]}`
      )
      break
    }
  }

  // --- 7. 每轮都有可追溯的上下文（铁律 11 / SC-006）----------------------
  run.packets.forEach((packet, index) => {
    if (packet.compilerVersion.trim() === '') {
      push('context_compiler', `第 ${index + 1} 轮的 ContextPacket 没有 compilerVersion`)
    }
    if (packet.sections.length === 0) {
      push('context_compiler', `第 ${index + 1} 轮的 ContextPacket 没有任何 section`)
    }
    /*
     * 身份 section 必须**每一轮**都在（计划书第 43 节：即使接近预算也不能先截掉身份核心）。
     *
     * M3 起 section id 从 `seed-identity` 变成 `identity-core`，两者都是合法的
     * 身份锚点 —— 前者是 M2.5 的编译路径（v1，仍可显式启用），后者是 M3 的
     * 默认路径（v2）。这里必须**同时接受两个 id**，否则：
     *   · 要么 v2 的每一轮都被误判为"人格锚点被裁掉了"
     *   · 要么为了让断言通过而把 id 改回去（那等于 M3 没做）
     *
     * 断言的本意是"人格锚点必须在"，而不是"必须叫那个名字"。
     */
    const identitySections = packet.sections.filter(
      (s) => s.id === 'identity-core' || s.id === 'seed-identity'
    )
    if (identitySections.length === 0) {
      push(
        'seed_presence',
        `第 ${index + 1} 轮的上下文里没有身份 section（identity-core / seed-identity 都不在，人格锚点被裁掉了）`
      )
    }
    // M3：身份 section 绝不允许可裁（它必须带 droppable === false）
    for (const section of identitySections) {
      if (section.droppable !== false) {
        push(
          'seed_not_droppable',
          `第 ${index + 1} 轮的身份 section ${section.id} 没有标 droppable=false（它可能被预算裁掉）`
        )
      }
    }
  })

  return violations
}
