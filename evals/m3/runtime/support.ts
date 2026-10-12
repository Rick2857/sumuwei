/**
 * M3 检查器的公共零件 —— **纯函数**，不碰数据库、不调模型、不看时间。
 *
 * ============================================================================
 *  这个文件是为了让"能程序判断的不用 Judge"（计划书第 52 节）变成默认
 * ============================================================================
 * 十二个套件里真正需要模型评分的只有四类问题：
 *
 *     她这个回答的**倾向方向**对吗？（PC）
 *     她说话**像不像她**？（SA / 风格）
 *     她在价值冲突里偏向哪边？（价值一致性，本质仍是 PC）
 *     40 道间接问题里的行为倾向对不对？（trait alignment）
 *
 * 其余全部都能用这里的函数判定。把它们收成一个文件，是为了让
 * "哪些是确定性的"这件事在代码里一目了然 —— 读这个文件的导出列表
 * 就等于读到确定性评测的全部能力清单。
 */

import {
  SOURCE_AUTHORITIES,
  SOURCE_KINDS,
  canEvidenceExternalFact,
  defaultAuthorityForKind,
  type CharacterDefinition,
  type ConversationEvent,
  type IdentitySnapshot,
} from '../../../src/kernel/contracts/index.ts'
import type { CheckResult, DeterministicCheck, EvalObservation, M3Metric } from '../types.ts'
import { IDENTITY_SECTION_IDS } from '../../harness/runner.ts'
import {
  SEED_BOUNDARY_KEYS,
  SEED_TRAIT_KEYS,
  SEED_VALUE_KEYS,
} from './seed-keys.ts'
import { AGGREGATE_OBSERVATION_KEY } from './metrics.ts'

// ---------------------------------------------------------------------------
// 检查结果构造
// ---------------------------------------------------------------------------

export const pass = (measured: string): CheckResult => ({ pass: true, measured })

export const fail = (detail: string, measured?: string): CheckResult => ({
  pass: false,
  detail,
  ...(measured ? { measured } : {}),
})

/**
 * 造一条**确定性检查**，并声明它归属哪个 M3 指标。
 *
 * `metric` 是 WP9 在本目录里补的字段（冻结的 `DeterministicCheck` 里没有它，
 * 因为那份类型只关心"检查是什么"，不关心"报告怎么汇总"）。
 * 用一个小工厂而不是在 12 个套件里各写一遍 `as`：这样
 * "哪条检查算进哪个指标"在调用点一眼可见，且永远不会忘记写。
 *
 * ---------------------------------------------------------------------------
 *  `echoAware`：为什么"看她说了什么"的检查在离线模式下必须让路
 * ---------------------------------------------------------------------------
 * 离线（echo）模式下，"回复"**不是她的话**，而是引擎为了让断言
 * 看见上下文而合成的机器可读串：
 *
 *     <m3-echo compiler=context-compiler@2 sections=identity-core+…>
 *
 * 它当然会包含 section 名与编译器名 —— 那是它的用途，不是缺陷。
 *
 * 一个不加区分的"回复里不得出现内部结构"检查会在离线模式下
 * **每一条用例都失败**，于是这套离线 Gate 变成永远红的噪声，
 * 而噪声比没有检查更糟：它会训练人忽略红色。
 *
 * 标了 `echoAware: true` 的检查在离线模式下被**跳过**（带明确原因），
 * 只在真实模型运行时生效 —— 那才是它本来要测的东西。
 *
 * 这与 Promptfoo 配置里既有的做法（`context.vars.modelMode !== 'real'`
 * 时不判 XML 泄漏）是同一条规矩，只是在内部 runner 上也实现一遍。
 */
export function det(options: {
  id: string
  description: string
  metric: M3Metric
  check: (observation: EvalObservation) => CheckResult
  /** 是否需要真实模型才有意义（离线模式下跳过） */
  echoAware?: boolean
}): DeterministicCheck {
  const base = {
    kind: 'deterministic' as const,
    id: options.id,
    description: options.description,
    check: options.check,
    metric: options.metric,
  }
  if (!options.echoAware) return base as DeterministicCheck

  return {
    ...base,
    check: (observation: EvalObservation): CheckResult => {
      if (isEchoObservation(observation)) {
        return pass('离线模式（echo）：回复不是她的话，本条不作判定')
      }
      return options.check(observation)
    },
  } as DeterministicCheck
}

/**
 * 这条观测的"回复"是不是 echo 模式的合成串。
 *
 * 判据是引擎写进 attributes 里的模式标记（唯一真源），
 * 而不是"回复里有没有 `<m3-echo`" —— 后者在模型恰好吐回类似文本时
 * 会误判，而误判的方向恰恰是"跳过一条本该执行的检查"。
 */
export function isEchoObservation(observation: EvalObservation): boolean {
  const mode = observation.attributes?.modelMode
  if (typeof mode === 'string') return mode === 'echo'
  // 没有标记时退回形状判据（老报告 / 手写观测）
  return observation.reply.trimStart().startsWith('<m3-echo')
}

/** 从观测里取"运行环境句柄"（拿不到时返回 undefined，**不抛**） */
export { runtimePortOf, portFrom } from './ports.ts'

/**
 * 本轮的身份 section id。
 *
 * ⚠️ 这个 id 在 M3 里换过一次：M2.5 是 `seed-identity`，
 * WP7 的 `context-compiler@2` 起是 `identity-core`。评测**必须两个都认**：
 * 库里可能还留着旧 Trace，而计划书第 122 节要求"每一轮都能回答
 * 她当时读的是哪一版身份"—— 认不出 id 就意味着这条保证断了。
 *
 * 因此这里直接复用 harness 的 `IDENTITY_SECTION_IDS`（唯一真源），
 * 不在这里再写一遍字面量。
 */
export function identitySectionIdOf(observation: EvalObservation): string | undefined {
  return observation.trace.sectionIds.find((id) =>
    (IDENTITY_SECTION_IDS as readonly string[]).includes(id)
  )
}

/** 身份 section 是否**被预算裁掉**（这是"她忘了自己是谁"的直接证据） */
export function identitySectionDropped(observation: EvalObservation): boolean {
  return observation.trace.droppedSectionIds.some((id) =>
    (IDENTITY_SECTION_IDS as readonly string[]).includes(id)
  )
}

// ---------------------------------------------------------------------------
// 身份快照
// ---------------------------------------------------------------------------

/**
 * Seed 版本引用串（形如 `character-definition:sumuwei@2`）。
 *
 * 与 `seedSourceRef()` 同形，但这里刻意接受 slug 或 id：
 * 旧 Trace（M2.5 期间写的）用的是 id，新的用 slug，
 * 评测必须两种都认，否则"重启后身份没变"会因为一个格式差异而假失败。
 */
export function seedRefMatches(
  refs: readonly string[],
  definition: CharacterDefinition,
  seedVersion: number
): boolean {
  const wanted = [
    `character-definition:${definition.slug}@${seedVersion}`,
    `character-definition:${String(definition.id)}@${seedVersion}`,
  ]
  return refs.some((ref) => wanted.includes(ref))
}

/**
 * 一条观测的**身份指纹**：CharacterId + Seed 版本 + 快照 hash。
 *
 * 用它做"跨轮 / 跨重启 / 跨会话身份不变"的判定：
 * 分别比较三个分量，比直接比一整串字符串更能说清是哪一个变了。
 */
export function identityFingerprint(identity: IdentitySnapshot): {
  characterId: string
  seedVersion: number
  snapshotHash: string
} {
  return {
    characterId: String(identity.characterId),
    seedVersion: identity.seedVersion,
    snapshotHash: identity.snapshotHash,
  }
}

/** 两个身份是否完全同一个（CharacterId / 版本 / 指纹三者都要相同） */
export function sameIdentity(a: IdentitySnapshot, b: IdentitySnapshot): boolean {
  const left = identityFingerprint(a)
  const right = identityFingerprint(b)
  return (
    left.characterId === right.characterId &&
    left.seedVersion === right.seedVersion &&
    left.snapshotHash === right.snapshotHash
  )
}

// ---------------------------------------------------------------------------
// 来源与完整性（T4–T8）
// ---------------------------------------------------------------------------

/**
 * 一条事件的 provenance 是否自洽。
 *
 * 判定完全按契约层的**唯一映射**来（`defaultAuthorityForKind`），
 * 而不是另写一份期望表 —— 否则契约改了、评测没改，就会开始漏报。
 *
 * 唯一允许的例外是 `USER_REPLY_CONFIRMATION`：它比默认权威**更高**，
 * 且只在"用户回复了她的生成内容"时出现（计划书第 33 节）。
 */
export function provenanceConsistent(event: ConversationEvent): CheckResult {
  if (!SOURCE_KINDS.includes(event.sourceKind)) {
    return fail(`事件 ${event.id} 的 sourceKind 非法：${String(event.sourceKind)}`)
  }
  if (!SOURCE_AUTHORITIES.includes(event.sourceAuthority)) {
    return fail(`事件 ${event.id} 的 sourceAuthority 非法：${String(event.sourceAuthority)}`)
  }

  const expected = defaultAuthorityForKind(event.sourceKind)
  if (event.sourceAuthority === expected) return pass(`${event.type} → ${expected}`)

  if (event.sourceKind === 'user_statement' && event.sourceAuthority === 'USER_REPLY_CONFIRMATION') {
    return pass(`${event.type} → USER_REPLY_CONFIRMATION（回复了她的生成内容）`)
  }

  return fail(
    `事件 ${event.id}（${event.type}）的权威等级与来源不符：` +
      `sourceKind=${event.sourceKind} 应当推出 ${expected}，实际是 ${event.sourceAuthority}`
  )
}

/**
 * 她的输出**不得**产生外部事实证据（计划书第 30/102/103 节，T4/T5）。
 *
 * 这是 M3 最重要的一条：Assistant → Fact 污染一旦发生，
 * M4 的 Memory 就会把它当长期事实（自增强错误链）。
 */
export function assistantCannotEvidenceFact(event: ConversationEvent): CheckResult {
  if (event.actorType !== 'character') return pass('非角色事件，不适用')
  if (event.sourceKind !== 'character_output') {
    return fail(
      `她的输出被标成了 ${event.sourceKind}（应为 character_output）：` +
        '这等于让她的话变成外部事实的证据'
    )
  }
  if (event.sourceAuthority !== 'CHARACTER_GENERATION') {
    return fail(
      `她的输出的权威等级是 ${event.sourceAuthority}（应为 CHARACTER_GENERATION）`
    )
  }
  if (canEvidenceExternalFact(event)) {
    return fail(`事件 ${event.id} 被判定为"可以支持外部事实"，但它是她自己生成的内容`)
  }
  return pass('character_output → CHARACTER_GENERATION（不可支持外部事实）')
}

/** 某个 actor 种类的输出**不得**出现在另一类来源里（T7/T8 的确定性部分） */
export function actorIsolatedToItsOwnKind(event: ConversationEvent): CheckResult {
  const expected: Record<ConversationEvent['actorType'], string> = {
    user: 'user_statement',
    character: 'character_output',
    system: 'system_instruction',
    tool: 'tool_output',
  }
  const want = expected[event.actorType]
  if (event.sourceKind !== want) {
    return fail(`actorType=${event.actorType} 的事件来源是 ${event.sourceKind}（应为 ${want}）`)
  }
  return pass(`${event.actorType} → ${want}`)
}

/** 逐条跑一组事件级检查，返回第一条失败（便于精确定位） */
export function everyEvent(
  events: readonly ConversationEvent[],
  checker: (event: ConversationEvent) => CheckResult,
  what: string
): CheckResult {
  if (events.length === 0) return fail(`没有可检查的事件（${what}）`)
  for (const event of events) {
    const result = checker(event)
    if (!result.pass) return result
  }
  return pass(`${events.length} 条事件全部通过：${what}`)
}

// ---------------------------------------------------------------------------
// 序号与账本完整性（硬零指标的判定材料）
// ---------------------------------------------------------------------------

/** 角色级序号是否严格单调递增（`EventOrderingErrorRate` 的判定核心） */
export function sequencesStrictlyIncreasing(events: readonly ConversationEvent[]): CheckResult {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].sequence <= events[i - 1].sequence) {
      return fail(
        `角色级序号倒序或重复：${events[i - 1].sequence} → ${events[i].sequence}` +
          `（事件 ${events[i - 1].id} → ${events[i].id}）`
      )
    }
  }
  return pass(`${events.length} 条事件的顺序号严格递增`)
}

/** 每个会话内的序号必须从 1 开始且不跳号（"处理了却没记账"会在跳号处露出来） */
export function conversationSequencesContiguous(
  events: readonly ConversationEvent[]
): CheckResult {
  const byConversation = new Map<string, number[]>()
  for (const event of events) {
    const key = String(event.conversationId)
    const list = byConversation.get(key) ?? []
    list.push(event.conversationSequence)
    byConversation.set(key, list)
  }
  for (const [conversationId, sequences] of byConversation) {
    const sorted = [...sequences].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i + 1) {
        return fail(
          `会话 ${conversationId} 的会话内序号不连续：第 ${i + 1} 位是 ${sorted[i]}`
        )
      }
    }
  }
  return pass(`${byConversation.size} 个会话的会话内序号都从 1 起连续`)
}

/** 每条她的事件都必须引用一条用户事件（reply graph 不断链） */
export function repliesWithinSameConversation(
  events: readonly ConversationEvent[]
): CheckResult {
  const byId = new Map(events.map((event) => [String(event.id), event]))
  for (const event of events) {
    if (!event.replyToEventId) continue
    const target = byId.get(String(event.replyToEventId))
    if (!target) {
      return fail(`事件 ${event.id} 回复了 ${event.replyToEventId}，但那条事件不在本次观测里`)
    }
    if (String(target.conversationId) !== String(event.conversationId)) {
      return fail(
        `跨会话回复：${event.id}（${event.conversationId}）回复了 ${target.id}（${target.conversationId}）`
      )
    }
  }
  return pass('reply graph 全部落在同一会话内')
}

// ---------------------------------------------------------------------------
// 文本层
// ---------------------------------------------------------------------------

/**
 * 回复里是否泄漏了**内部结构**（section 名、XML 标签、Trace 字段）。
 *
 * 这是纯确定性检查里唯一直接看文本的一条，也是为什么每个套件都带着它：
 * 它同时覆盖"提示词泄漏"与"echo 模式的格式串跑到真实回复里"两类事故。
 */
const INTERNAL_LEAK_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'section 名', pattern: /seed-identity|critical-state|recent-conversation|integrity-rules/ },
  { name: '编译器名', pattern: /ContextCompiler|context-compiler@/ },
  { name: 'XML 结构', pattern: /<\/?(response|thought|actions|providers|output)\b/i },
  { name: 'Trace 字段', pattern: /snapshotHash|seedVersion|sourceAuthority|epistemicSource/ },
]

export function noInternalLeak(reply: string): CheckResult {
  for (const { name, pattern } of INTERNAL_LEAK_PATTERNS) {
    if (pattern.test(reply)) {
      return fail(`回复里出现了内部结构（${name}）：${excerpt(reply)}`)
    }
  }
  return pass('回复里没有内部结构泄漏')
}

/** 回复里不得出现被禁止的措辞（用例自己给的 `forbidPatterns`） */
export function forbids(reply: string, patterns: readonly string[]): CheckResult {
  for (const pattern of patterns) {
    const hit = new RegExp(pattern, 'i').exec(reply)
    if (hit) {
      return fail(`回复里出现了不该出现的措辞 /${pattern}/：${excerpt(reply)}`)
    }
  }
  return pass(`未命中 ${patterns.length} 条禁止模式`)
}

/** 回复的长度下限：空回复与"嗯"不算回答（人格评测里它会让 judge 乱给分） */
export function replySubstantive(reply: string, minChars = 6): CheckResult {
  const trimmed = reply.trim()
  if (trimmed.length < minChars) {
    return fail(`回复太短（${trimmed.length} 字），无法作为人格证据：${JSON.stringify(reply)}`)
  }
  return pass(`${trimmed.length} 字`)
}

// ---------------------------------------------------------------------------
// Seed 内容（套件要"严格依据 Seed"，所以这些断言直接读定义）
// ---------------------------------------------------------------------------

/** Seed 里必须存在的倾向名（来自 `KNOWN_TRAITS`，评测不许自己发明人格） */
export const SEED_TRAIT_NAMES = SEED_TRAIT_KEYS

/** Seed 里必须存在的价值名（来自 `KNOWN_VALUES`） */
export const SEED_VALUE_NAMES = SEED_VALUE_KEYS

/** Seed 里必须存在的边界条款（来自 `KNOWN_BOUNDARIES`） */
export const SEED_BOUNDARIES = SEED_BOUNDARY_KEYS

export function definitionHasTraits(
  definition: CharacterDefinition,
  names: readonly string[]
): CheckResult {
  const present = new Set(definition.personality.traits.map((t) => t.trait))
  const missing = names.filter((name) => !present.has(name))
  if (missing.length > 0) {
    return fail(`Seed 缺少倾向：${missing.join('、')}（评测用例必须严格依据 Seed，不许发明人格）`)
  }
  return pass(`${names.length} 条倾向齐全`)
}

export function definitionHasValues(
  definition: CharacterDefinition,
  names: readonly string[]
): CheckResult {
  const present = new Set(definition.values.map((v) => v.value))
  const missing = names.filter((name) => !present.has(name))
  if (missing.length > 0) return fail(`Seed 缺少价值：${missing.join('、')}`)
  return pass(`${names.length} 条价值齐全`)
}

export function definitionHasBoundaries(definition: CharacterDefinition): CheckResult {
  const missing = SEED_BOUNDARIES.filter((line) => !definition.boundaries.includes(line))
  if (missing.length > 0) {
    return fail(`Seed 缺少边界条款：\n  · ${missing.join('\n  · ')}`)
  }
  return pass(`${SEED_BOUNDARIES.length} 条边界齐全`)
}

/**
 * 每条倾向都必须有**反例**（计划书第 15 节）。
 *
 * 这条检查存在的意义：反例是人设的防漫画化机制，
 * 一旦某条被删掉，她就会开始"演得比设定更极端"——
 * 而那在单轮评测里看起来只是"更有性格"。
 */
export function everyTraitHasCounterExamples(definition: CharacterDefinition): CheckResult {
  const missing = definition.personality.traits
    .filter((t) => (t.counterExamples ?? []).length === 0)
    .map((t) => t.trait)
  if (missing.length > 0) return fail(`这些倾向没有反例（会被演成漫画）：${missing.join('、')}`)
  return pass(`${definition.personality.traits.length} 条倾向都带反例`)
}

/**
 * 造一条**装置专用**的观测：判定对象是状态快照，而不是某几轮对话。
 *
 * 什么时候需要它：重启（T1）、开新会话（T2）这类用例的判定对象是
 * "重启前后的身份指纹"、"两个会话的 id"这种行为，它们不来自任何一轮。
 * 装置把这些事实放进 `attributes` 交出来，因此需要一条"载体"观测。
 *
 * `baseline` 用来给身份字段找个真实来源 —— 给 `facade.identity()` 的结果，
 * 这样"这一轮用的是哪一版人格"仍然是**真的**，而不是编出来的。
 */
export function snapshotObservation(options: {
  identity: EvalObservation['identity']
  attributes: Record<string, unknown>
  /** 事件与 trace 留空：这类观测判定的是状态，不是事件 */
  note: string
}): EvalObservation {
  return {
    caseId: '',
    reply: options.note,
    identity: options.identity,
    trace: {
      traceId: 'snapshot-only',
      compilerVersion: 'not-applicable',
      sectionIds: [],
      droppedSectionIds: [],
      identitySourceRefs: [],
    },
    newEvents: [],
    conversationSequence: 0,
    attributes: {
      ...options.attributes,
      [AGGREGATE_OBSERVATION_KEY]: true,
    },
    durationMs: 0,
  }
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

export function excerpt(text: string, max = 160): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
}

/** 平均分（judge 分数用；空数组 → undefined，**不返回 0**） */
export function meanOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 取观测里的字符串属性（用例自定义元数据；缺省 undefined，**不抛**） */
export function attributeText(observation: EvalObservation, key: string): string | undefined {
  const value = observation.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

/** 取观测里的数值属性 */
export function attributeNumber(observation: EvalObservation, key: string): number | undefined {
  const value = observation.attributes?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// 聚合观测（跨轮序列的判定对象）
// ---------------------------------------------------------------------------

/**
 * 把若干轮观测拼成**一条**观测。
 *
 * 为什么需要它：有些用例的判定对象是一段序列，而不是最后一轮。
 * 最典型的是 T6 ——"她先说了一句 → 用户回复了她那句"，
 * 而判定要同时看**两条事件**（一条是 character、一条是 user，且后者引用前者）。
 *
 * 拼接规则刻意保守：
 *   · `newEvents` 按传入顺序去重合并（因此检查能一次看全）
 *   · `reply` / `identity` / `trace` 取**最后一条**（代表"此刻的状态"）
 *   · `attributes` 合并，并打上 `AGGREGATE_OBSERVATION` 标记，引擎不再改写它
 *
 * 这样"检查只读观测"这条纪律不被打破：聚合观测仍然是观测。
 */
export function aggregateObservations(
  observations: readonly EvalObservation[],
  attributes: Record<string, unknown> = {}
): EvalObservation {
  if (observations.length === 0) throw new Error('aggregateObservations：没有可聚合的观测')
  const last = observations[observations.length - 1]

  const seen = new Set<string>()
  const newEvents = observations
    .flatMap((observation) => observation.newEvents)
    .filter((event) => {
      const key = String(event.id)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.sequence - right.sequence)

  return {
    ...last,
    newEvents,
    conversationSequence: Math.max(...observations.map((item) => item.conversationSequence)),
    attributes: {
      ...Object.assign({}, ...observations.map((item) => item.attributes ?? {})),
      ...attributes,
      [AGGREGATE_OBSERVATION_KEY]: true,
    },
    durationMs: observations.reduce((sum, item) => sum + item.durationMs, 0),
  }
}
