/**
 * CharacterIntent —— **Character Kernel 的输出边界**。
 *
 * ============================================================================
 *  M3.5 WP4（计划书第 15–24 / 50 / 69 / 70 / 77 / 78 节）
 * ============================================================================
 * M3 的 Kernel 最终输出是 `Assistant Response`（一个字符串）。今天它完全够用，
 * 因为它唯一的去处就是"把文本发给用户"。但它隐含了一个非常贵的假设：
 *
 *     角色想做某件事  ==  那件事真的发生了
 *
 * 未来一旦她"想开灯"，这个假设就会变成：
 *
 *     她想开灯  →  世界把灯打开了
 *
 * 而那会一次性破坏五样东西（计划书第 24 节）：
 * 因果、规则、多角色冲突、权限、世界真实性。
 *
 * ---------------------------------------------------------------------------
 *  铁律：Character 只能产生 Intent（计划书第 20 / 24 节）
 * ---------------------------------------------------------------------------
 * ```text
 * CharacterIntent("打开门")
 *        ↓
 * Environment Resolver        ← 由环境决定能不能
 *        ↓
 * IntentResolution("rejected")
 *        ↓
 * Observation("门打不开")      ← 结果以**观测**的形式回到她这里
 * ```
 *
 * `Intent ≠ Result` 必须是**两件事**。M3.5 只建这条边界与它的端口，
 * **不实现任何 Environment Resolver**（计划书第 21 节）。
 *
 * ---------------------------------------------------------------------------
 *  M3.5 真正产出只有一种
 * ---------------------------------------------------------------------------
 *     Kernel → SpeechIntent → ConversationIntentResolver → Assistant Message
 *
 * 其余五种（ACTION / MOVEMENT / INTERACTION / TOOL_USE / WAIT）**只登记枚举**。
 * `CharacterOutput.intents` 在 M3.5 恒为**恰好一条** SPEECH（计划书第 19 节），
 * 由 `assertM3_5OutputInvariant` 在运行期守住 —— 这样未来的多 intent
 * 不需要改变返回结构，只需要放宽这一条断言。
 */

import {
  KernelError,
  newIntentId,
  type CharacterId,
  type IntentId,
  type ObservationId,
  type Timestamp,
} from './ids.ts'
import { type EntityRef, entityLabel } from './entity.ts'

// ---------------------------------------------------------------------------
// 类型登记
// ---------------------------------------------------------------------------

/**
 * Intent 种类（受控登记表）。
 *
 * `SPEECH` 之外的五种**只登记**：登记它们让"她能做什么"有一份完整清单，
 * 而 `M3_5_PRODUCIBLE_INTENT_TYPES` 保证今天只有一种真的会被造出来。
 */
export type CharacterIntentType =
  /** ✅ M3.5 唯一真正产出的一种 */
  | 'SPEECH'
  // —— 以下仅登记（计划书第 17 节）——
  | 'ACTION'
  | 'MOVEMENT'
  | 'INTERACTION'
  | 'TOOL_USE'
  | 'WAIT'

export const CHARACTER_INTENT_TYPES: readonly CharacterIntentType[] = [
  'SPEECH',
  'ACTION',
  'MOVEMENT',
  'INTERACTION',
  'TOOL_USE',
  'WAIT',
]

export const M3_5_PRODUCIBLE_INTENT_TYPES: readonly CharacterIntentType[] = ['SPEECH']

export function isCharacterIntentType(value: unknown): value is CharacterIntentType {
  return typeof value === 'string' && (CHARACTER_INTENT_TYPES as readonly string[]).includes(value)
}

export function isProducibleIntentInM3_5(type: CharacterIntentType): boolean {
  return (M3_5_PRODUCIBLE_INTENT_TYPES as readonly string[]).includes(type)
}

// ---------------------------------------------------------------------------
// CharacterIntent
// ---------------------------------------------------------------------------

export interface CharacterIntent {
  id: IntentId

  /** **谁**想做这件事（未来多角色世界里的 actor，计划书第 48 节） */
  characterId: CharacterId

  type: CharacterIntentType

  /**
   * 这个 intent 是从哪些观测来的（计划书第 15 节）。
   *
   * 它回答"她为什么要做这件事"。允许复数是因为"看到 A 又听到 B 才决定做 C"
   * 本来就是常态；允许为空是因为合成轮次（`--dump-prompt` / 既有测试）
   * 没有 Observation，那时**空数组是事实**，编一个假的来源才是错的。
   */
  sourceObservationIds: ObservationId[]

  /** 具体内容。形状由 `type` 决定（`SPEECH` → `SpeechIntentPayload`） */
  payload: unknown

  createdAt: Timestamp

  metadata?: Record<string, unknown>
}

/**
 * 当前唯一被实现的 payload（计划书第 16 节）。
 *
 * `target` 是 `EntityRef` 而不是 `UserId`：今天它恒为用户，
 * 但"对谁说"在类型上就应该是"对某个实体说"，否则未来对角色 B 说话
 * 必须改这个接口 —— 而接口一改，所有生产 SpeechIntent 的地方都要动。
 * 这正是 M3.5 要提前消掉的那类改动。
 */
export interface SpeechIntentPayload {
  text: string
  target?: EntityRef
}

export interface NewCharacterIntent {
  characterId: CharacterId
  type: CharacterIntentType
  payload: unknown
  sourceObservationIds?: ObservationId[]
  createdAt?: Timestamp
  metadata?: Record<string, unknown>
  /** 只用于测试：显式指定 id，让断言可复现 */
  id?: IntentId
}

/**
 * 构造 Intent（通用入口，校验类型已登记 + payload 非空）。
 *
 * 刻意**不**校验"这个 type 现在可产出" —— 校验它是 `assertM3_5OutputInvariant`
 * 与产出侧的职责。理由：测试需要造 ACTION intent 来证明"它不会变成世界变更"
 * （FC-T04），如果构造器就把非 SPEECH 拒掉，那条测试根本写不出来，
 * 而"Intent ≠ Result"这条铁律也就没人守了。
 */
export function createCharacterIntent(input: NewCharacterIntent): CharacterIntent {
  if (!isCharacterIntentType(input.type)) {
    throw new KernelError(
      'validation_error',
      'unknown_intent_type',
      `未登记的 CharacterIntentType：${String(input.type)}`
    )
  }
  if (String(input.characterId).trim() === '') {
    throw new KernelError('validation_error', 'intent_without_character', 'Intent 必须属于某个角色')
  }
  if (input.payload === undefined || input.payload === null) {
    throw new KernelError(
      'validation_error',
      'empty_intent_payload',
      'Intent 必须带 payload：一个空的"她想做某事"没有任何可执行内容'
    )
  }

  const createdAt = input.createdAt ?? Date.now()
  if (!Number.isFinite(createdAt)) {
    throw new KernelError(
      'validation_error',
      'bad_intent_created_at',
      `Intent.createdAt 必须是有限时间戳，收到 ${String(createdAt)}`
    )
  }

  return {
    id: input.id ?? newIntentId(),
    characterId: input.characterId,
    type: input.type,
    sourceObservationIds: dedupeIds(input.sourceObservationIds ?? []),
    payload: input.payload,
    createdAt,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}

/** 构造 SpeechIntent（M3.5 唯一真正使用的入口） */
export function createSpeechIntent(input: {
  characterId: CharacterId
  text: string
  target?: EntityRef
  sourceObservationIds?: ObservationId[]
  createdAt?: Timestamp
  metadata?: Record<string, unknown>
  id?: IntentId
}): CharacterIntent {
  const text = input.text.trim()
  if (text === '') {
    throw new KernelError(
      'validation_error',
      'empty_speech_intent',
      'SpeechIntent 的正文不能为空：她"说了什么都不说"不是一条 intent'
    )
  }
  const payload: SpeechIntentPayload = { text }
  if (input.target !== undefined) payload.target = input.target

  return createCharacterIntent({
    characterId: input.characterId,
    type: 'SPEECH',
    payload,
    ...(input.sourceObservationIds !== undefined
      ? { sourceObservationIds: input.sourceObservationIds }
      : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
  })
}

/**
 * 取出 SpeechIntent 的 payload（**唯一**的读取口，带形状校验）。
 *
 * 非 SPEECH 返回 `undefined` 而不是抛错：调用方（Resolver）需要
 * "这个 intent 我处理不了"这个信息，而不是一次异常 —— 未来多个 Resolver
 * 并存时，"处理不了"是正常路由结果，不是故障。
 */
export function speechPayloadOf(intent: CharacterIntent): SpeechIntentPayload | undefined {
  if (intent.type !== 'SPEECH') return undefined
  const payload = intent.payload
  if (payload === null || typeof payload !== 'object') {
    throw new KernelError(
      'validation_error',
      'bad_speech_payload',
      'SPEECH intent 的 payload 必须是对象（{ text, target? }）'
    )
  }
  const record = payload as Partial<SpeechIntentPayload>
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    throw new KernelError(
      'validation_error',
      'empty_speech_payload',
      'SPEECH intent 的 payload.text 不能为空'
    )
  }
  return record.target !== undefined
    ? { text: record.text, target: record.target }
    : { text: record.text }
}

/** 人类可读描述（进日志 / trace 的 attributes；**不含正文**） */
export function describeIntent(intent: CharacterIntent): string {
  const target = speechPayloadOf(intent)?.target
  return `${intent.type}${target ? ` → ${entityLabel(target)}` : ''}`
}

// ---------------------------------------------------------------------------
// CharacterOutput（计划书第 19 / 70 / 77 节）
// ---------------------------------------------------------------------------

/**
 * 角色对外的一次输出。
 *
 * ⚠️ 这个包装的存在理由只有一个：**以后不要改返回结构**。
 *
 * 如果今天 Kernel 对外仍然只返回 `string`，那么未来出现第一个非语言行为
 * （"她走过去把窗关上"）时，Runtime API 就必须从 `Promise<string>`
 * 变成 `Promise<Something>` —— 而那是一个**破坏性**变更，会牵动
 * 装配层、评测装置、trace 与所有调用点。
 *
 * 今天多一层 `{ intents: [...] }`，成本是一个对象；收益是那个变更永远不必发生。
 */
export interface CharacterOutput {
  intents: CharacterIntent[]
}

/** 恒等包装（M3.5 只有一种 intent，因此总是"单条"） */
export function singleSpeechOutput(intent: CharacterIntent): CharacterOutput {
  return { intents: [intent] }
}

/**
 * M3.5 的输出不变量：**恰好一条，且必须是 SPEECH**（计划书第 19 节）。
 *
 * 它在**运行期**守住"M3.5 没有偷偷产出别的东西"。
 * 未来放宽它（比如允许多条 intent）时，这条断言就是唯一需要改的地方，
 * 而它被改的那一刻会有人看见 —— 这比"约定不变"可靠。
 */
export function assertM3_5OutputInvariant(output: CharacterOutput): void {
  if (output.intents.length !== 1) {
    throw new KernelError(
      'validation_error',
      'm3_5_output_must_be_single_intent',
      `M3.5 的角色输出必须恰好一条 intent，收到 ${output.intents.length} 条。` +
        '放宽这条约束属于后续阶段的范围（计划书第 19 节）'
    )
  }
  const [intent] = output.intents
  if (!isProducibleIntentInM3_5(intent.type)) {
    throw new KernelError(
      'validation_error',
      'm3_5_output_intent_not_supported',
      `M3.5 只能产出 ${M3_5_PRODUCIBLE_INTENT_TYPES.join('/')}，收到 ${intent.type}。` +
        '其它 intent 已经在枚举里登记，但还没有 Resolver 能处理它们',
      { type: intent.type }
    )
  }
}

// ---------------------------------------------------------------------------
// IntentResolution / IntentResolver（计划书第 21–23 节）
// ---------------------------------------------------------------------------

/**
 * 结果状态（计划书第 23 节）。
 *
 *   accepted —— 环境接受了这个 intent（对话里 = 已经落成一条她的回复事件）
 *   rejected —— 环境**明确拒绝**（门锁着）—— 这是正常结果，不是故障
 *   failed   —— 环境想处理但失败了（IO 错误这一层）
 *
 * ⚠️ `rejected` 与 `failed` 的区别是**故意保留**的：
 * 未来她"想开门但门锁着"应该得到一个**可观测的世界事实**（"门打不开"），
 * 而"网络超时导致发送失败"是运维问题。把两者混成"没成功"，
 * 就会让她把基础设施故障当成世界规律写进 Belief。
 */
export type IntentResolutionStatus = 'accepted' | 'rejected' | 'failed'

export interface IntentResolution {
  intentId: IntentId
  status: IntentResolutionStatus

  /**
   * 这次 resolve 产生了什么（事件 id / 未来的世界对象 id）。
   *
   * `IntentResolution` **不持有**它指向的东西本身，只有引用 ——
   * 这样"结果"永远是去别处查的，而不是这里的一份快照。
   */
  resultRefs?: string[]

  /** 可选：被拒绝时的理由（进日志；**不是**世界事实） */
  reason?: string

  resolvedAt: Timestamp
}

/**
 * 环境（或 transport）如何把 Intent 变成结果。
 *
 * M3.5 只定义**端口**，唯一实现是 `ConversationIntentResolver`
 * （`SpeechIntent → 落一条 assistant 事件`，计划书第 22 节）。
 *
 * 注意签名里**没有** context 参数：resolver 需要的上下文（哪个会话、第几号、
 * 回复谁）在**构造时**绑定。这样做是因为端口要能被未来的
 * Environment Resolver 复用，而"世界"不需要知道我们的会话序号。
 */
export interface IntentResolver {
  readonly name: string
  resolve(intent: CharacterIntent): Promise<IntentResolution>
}

/** 便捷构造（保持 `resultRefs` 只出现在有内容的时候） */
export function intentResolutionOf(
  intentId: IntentId,
  status: IntentResolutionStatus,
  options: { resultRefs?: string[]; reason?: string; resolvedAt?: Timestamp } = {}
): IntentResolution {
  const resolution: IntentResolution = {
    intentId,
    status,
    resolvedAt: options.resolvedAt ?? Date.now(),
  }
  if (options.resultRefs !== undefined) resolution.resultRefs = options.resultRefs
  if (options.reason !== undefined) resolution.reason = options.reason
  return resolution
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function dedupeIds(values: readonly ObservationId[]): ObservationId[] {
  const seen = new Set<string>()
  const result: ObservationId[] = []
  for (const value of values) {
    const key = String(value)
    if (key.trim() === '' || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}
