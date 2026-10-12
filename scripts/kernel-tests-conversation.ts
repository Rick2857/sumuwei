/**
 * 对话完整性测试 —— M3 的 Conversation Integrity 与 Source Firewall
 * （计划书第 98–120 节：T4 / T5 / T6 / T7 / T8 / T15 的领域侧部分）。
 *
 * ============================================================================
 *  这是 M3 最重要的一批断言
 * ============================================================================
 * 计划书第 30 节把 Assistant Fact Firewall 称为"M3 最关键的实现之一"，
 * 而第 115 节给了它一个必须为 0 的指标：
 *
 *   > Assistant→Fact Contamination Rate
 *   > 在 deterministic source pipeline 中应为 0。
 *
 * 这些测试就是那个"deterministic source pipeline"的守门人：
 * 它们全部是纯函数判定，不调模型、不碰数据库，因此**可以证明**为 0，
 * 而不是"跑了一百次没看到"。
 *
 * 跑法：
 *   node_modules/.bin/tsx scripts/kernel-tests-conversation.ts
 */

import {
  KernelError,
  SOURCE_AUTHORITIES,
  SOURCE_KINDS,
  assertSourceConsistency,
  buildProvenance,
  canEvidenceExternalFact,
  canSupportExternalFact,
  createConversationEvent,
  defaultAuthorityForKind,
  deriveSourceForLegacyRow,
  epistemicSourceForKind,
  isCharacterGeneration,
  isDirectInteraction,
  isSelfExpressionOnly,
  normalizeConversationInput,
  resolveAuthority,
  sourceKindForActor,
  validateActorConsistency,
  validateConversationSequence,
  validateIntegrity,
  validateParticipants,
  validateReplyGraph,
  SECTION_PRIORITY,
  type ActorType,
  type CharacterId,
  type ContextSection,
  type ConversationEventId,
  type ConversationEventType,
  type ConversationId,
  asCharacterId,
  asConversationEventId,
  asConversationId,
} from '../src/kernel/contracts/index.ts'

import {
  buildContextCompilerV2,
  renderClockBlock,
  type ConversationLine,
} from '../src/kernel/context/sections.ts'
import {
  BASELINE_CURRENT_INPUT,
  BASELINE_RECENT_LINES,
  baselineIdentity,
} from './m3.5-prompt-baseline.ts'
import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'

// ---------------------------------------------------------------------------
const characterId = asCharacterId('char_test')
const conversationId = asConversationId('dm-test')
const otherConversationId = asConversationId('dm-other')

const event = (
  overrides: Partial<Parameters<typeof createConversationEvent>[0]> = {}
): ReturnType<typeof createConversationEvent> =>
  createConversationEvent({
    characterId,
    conversationId,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    content: '我喜欢咖啡。',
    sequence: 1,
    ...overrides,
  } as Parameters<typeof createConversationEvent>[0])

// ===========================================================================
group('来源隔离 :: SourceKind 推导')
// ===========================================================================

test('每种 actor 唯一推导出一种来源类别（没有"看情况"的余地）', () => {
  expect.equal(sourceKindForActor('user'), 'user_statement')
  expect.equal(sourceKindForActor('character'), 'character_output')
  expect.equal(sourceKindForActor('system'), 'system_instruction')
  expect.equal(sourceKindForActor('tool'), 'tool_output')
})

test('来源类别与认知产物一一对应（不会出现自相矛盾的组合）', () => {
  expect.equal(epistemicSourceForKind('user_statement'), 'user_report')
  expect.equal(epistemicSourceForKind('character_output'), 'character_generation')
  expect.equal(epistemicSourceForKind('system_instruction'), 'system_instruction')
  expect.equal(epistemicSourceForKind('tool_output'), 'tool_observation')
})

test('来源类别枚举是封闭的（新增必须显式改契约）', () => {
  expect.deepEqual([...SOURCE_KINDS].sort(), [
    'character_output',
    'story_fact',
    'system_instruction',
    'tool_output',
    'user_statement',
  ])
  // M5.1.1 WP1.1：Axis B 追加 `UNCONFIRMED_ORIGIN`（ADR-042 §4 / U-09）⇒ 基数 6 → 7。
  // 后 Lv2 S1：Axis B 追加 `STORY_OBSERVATION`（ADR-091 D04）⇒ 基数 7 → 8。
  // **判据没有被放宽**：它仍然是"精确基数 + 封闭枚举"；改的只是那个精确值。
  // 逐条记录见 docs/m5.1.1/M5.1.1-WP1.1-Compatible-Assertion-Record.md
  // 与 docs/post-lv2/Post-Lv2-Execution-Plan.md §6 的 R2 记录。
  expect.equal(SOURCE_AUTHORITIES.length, 8)
  /*
   * ⚠️ 同时钉住"actor 派生"这一侧**没有**被故事来源污染：
   * `story_fact` 不是 actor 推出来的，因此 `sourceKindForActor` 的返回域仍是那四个。
   * （ADR-091 D04 第 3 条硬约束；`ACTOR_DERIVED_SOURCE_KINDS` 是它的机器形态。）
   */
  expect.equal(
    SOURCE_KINDS.filter((kind) => kind !== 'story_fact').sort().join(','),
    ['character_output', 'system_instruction', 'tool_output', 'user_statement'].sort().join(','),
    '轴一只有 story_fact 是新值，其余四个仍是 actor 派生域'
  )
})

test('声明与 actor 不符 → 拒绝（失败关闭，而不是"以声明为准"）', () => {
  let error: KernelError | undefined
  try {
    assertSourceConsistency({ actorType: 'character', declaredKind: 'user_statement' })
  } catch (e) {
    error = e as KernelError
  }
  expect.ok(error, '她生成的内容不能声明成用户陈述')
  expect.equal(error!.code, 'source_kind_actor_mismatch')
})

// ===========================================================================
group('来源隔离 :: Assistant Fact Firewall（T4 / T5）')
// ===========================================================================

test('T4/T5：她自己生成的内容**永远不能**支持外部事实', () => {
  // 计划书第 115 节：这一条必须为 0，所以它必须被证明，而不是被观察
  expect.notOk(
    canSupportExternalFact('CHARACTER_GENERATION'),
    '"我小时候很喜欢下雨"不能变成"苏沐薇小时候喜欢下雨"这个事实'
  )
  expect.ok(isCharacterGeneration('CHARACTER_GENERATION'))
})

test('系统指令不能支持外部事实（T7：系统提示不是她的经历）', () => {
  expect.notOk(
    canSupportExternalFact('SYSTEM_INSTRUCTION'),
    '系统说"请以简洁方式回答"不能变成"她记得有人曾要求自己简洁"'
  )
})

test('用户陈述与用户确认可以支持外部事实（T6：权威来自第二条 User Event）', () => {
  expect.ok(canSupportExternalFact('USER_EXPLICIT'))
  expect.ok(canSupportExternalFact('USER_REPLY_CONFIRMATION'))
})

test('工具观测可以支持外部事实，但它是 tool_observation 而不是 user_report（T8）', () => {
  expect.ok(canSupportExternalFact('TOOL_OBSERVATION'))
  expect.equal(epistemicSourceForKind('tool_output'), 'tool_observation')
  expect.notOk(
    epistemicSourceForKind('tool_output') === 'user_report',
    '工具返回"用户年龄 20"绝不能冒充用户陈述'
  )
})

test('DIRECT_INTERACTION 不在白名单里：真实互动支持"发生过"，不支持"事实为真"', () => {
  expect.notOk(
    canSupportExternalFact('DIRECT_INTERACTION'),
    '这一轮真实发生过 ≠ 这一轮里说的内容为真（否则用户说"月球是奶酪做的"就成了世界事实）'
  )
})

test('白名单是封闭的：任何未列入的权威等级默认不能支持外部事实', () => {
  // 这条测试保护的是"新增一种 authority 时不会悄悄获得制造事实的权力"
  const allowed = SOURCE_AUTHORITIES.filter((a) => canSupportExternalFact(a))
  expect.deepEqual([...allowed].sort(), [
    'TOOL_OBSERVATION',
    'USER_EXPLICIT',
    'USER_REPLY_CONFIRMATION',
  ])
})

// ===========================================================================
group('来源隔离 :: 事件构造（T4–T8 的落地点）')
// ===========================================================================

test('T4：她自己说的话只构成自我表达证据，不是外部事实', () => {
  const assistant = event({
    type: 'assistant_message',
    actorType: 'character',
    actorId: 'char_test',
    content: '我小时候很喜欢下雨。',
    sequence: 2,
  })
  expect.equal(assistant.sourceKind, 'character_output')
  expect.equal(assistant.sourceAuthority, 'CHARACTER_GENERATION')
  expect.equal(assistant.epistemicSource, 'character_generation')
  expect.notOk(canEvidenceExternalFact(assistant))
  expect.ok(isSelfExpressionOnly(assistant))
})

test('T6：回复她生成内容的用户事件升级为 USER_REPLY_CONFIRMATION', () => {
  const confirmation = event({
    type: 'user_message',
    actorType: 'user',
    content: '对，我确实很喜欢。',
    sequence: 3,
    repliedToSourceKind: 'character_output',
  })
  expect.equal(confirmation.sourceAuthority, 'USER_REPLY_CONFIRMATION')
  expect.ok(canEvidenceExternalFact(confirmation))
})

test('T6 反面：用户没有在回复她的内容时，权威只是 USER_EXPLICIT（不擅自升级）', () => {
  const plain = event({ sequence: 4, repliedToSourceKind: 'user_statement' })
  expect.equal(plain.sourceAuthority, 'USER_EXPLICIT')
})

test('T7：系统事件不能成为用户陈述', () => {
  const system = event({
    type: 'system_event',
    actorType: 'system',
    actorId: 'scheduler',
    content: '使用更简洁表达。',
    sequence: 5,
  })
  expect.equal(system.sourceKind, 'system_instruction')
  expect.notOk(canEvidenceExternalFact(system))
})

test('T8：工具事件是 tool_output，且不能被当成用户陈述', () => {
  const tool = event({
    type: 'tool_event',
    actorType: 'tool',
    actorId: 'profile-lookup',
    content: '用户年龄 20',
    sequence: 6,
  })
  expect.equal(tool.sourceKind, 'tool_output')
  expect.equal(tool.epistemicSource, 'tool_observation')
  expect.notOk(isSelfExpressionOnly(tool), '工具不是"她自己的表达"')
  expect.ok(isDirectInteraction({ actorType: 'user' }))
  expect.notOk(isDirectInteraction({ actorType: 'tool' }), '工具不是互动的一方')
})

test('伪造来源被拒绝：type 与 actorType 必须匹配（四个方向都测）', () => {
  const cases: { type: ConversationEventType; actorType: ActorType }[] = [
    { type: 'user_message', actorType: 'character' },
    { type: 'assistant_message', actorType: 'user' },
    { type: 'system_event', actorType: 'tool' },
    { type: 'tool_event', actorType: 'system' },
  ]
  for (const item of cases) {
    let threw = false
    try {
      event({ type: item.type, actorType: item.actorType, sequence: 10 })
    } catch {
      threw = true
    }
    expect.ok(threw, `${item.type} 配 ${item.actorType} 必须被拒绝`)
  }
})

test('声明的来源与 actor 不一致时，构造事件直接失败', () => {
  let error: KernelError | undefined
  try {
    event({
      type: 'assistant_message',
      actorType: 'character',
      actorId: 'char_test',
      // 她生成的回复却声明成用户陈述 —— 这正是要拦住的伪造
      sourceKind: 'user_statement',
      sequence: 10,
    })
  } catch (e) {
    error = e as KernelError
  }
  expect.ok(error !== undefined, '来源矛盾必须拒绝')
  expect.equal(error!.code, 'source_kind_actor_mismatch')
})

test('assistant 事件必须带 actorId（否则无法回答"哪条回复属于哪个角色"）', () => {
  let error: KernelError | undefined
  try {
    event({ type: 'assistant_message', actorType: 'character', actorId: undefined, sequence: 11 })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'missing_actor_id')
})

test('空正文被拒绝（空的"事实"只会污染账本）', () => {
  let error: KernelError | undefined
  try {
    event({ content: '   ', sequence: 12 })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'empty_content')
})

test('旧数据（迁移前没有来源列）按 actorType 推导来源，而不是留空', () => {
  // 账本里"来源未知"的事件比"来源正确推导"的事件危险得多：
  // 前者会被 M4 当成"什么都有可能"
  expect.equal(deriveSourceForLegacyRow('user').sourceKind, 'user_statement')
  expect.equal(deriveSourceForLegacyRow('character').sourceAuthority, 'CHARACTER_GENERATION')
  expect.equal(deriveSourceForLegacyRow('tool').epistemicSource, 'tool_observation')
  expect.equal(deriveSourceForLegacyRow('system').epistemicSource, 'system_instruction')
})

// ===========================================================================
group('来源隔离 :: 默认权威与提升')
// ===========================================================================

test('计划书第 33 节的判定完全由 reply graph 驱动，不做语义判断', () => {
  expect.equal(
    resolveAuthority({ kind: 'user_statement', repliedToKind: 'character_output' }),
    'USER_REPLY_CONFIRMATION'
  )
  expect.equal(
    resolveAuthority({ kind: 'user_statement', repliedToKind: 'user_statement' }),
    'USER_EXPLICIT'
  )
  expect.equal(
    resolveAuthority({ kind: 'user_statement' }),
    'USER_EXPLICIT',
    '没有 reply 上下文时默认不升级（保守方向）'
  )
})

test('默认权威表与 SourceKind 一一对应', () => {
  expect.equal(defaultAuthorityForKind('user_statement'), 'USER_EXPLICIT')
  expect.equal(defaultAuthorityForKind('character_output'), 'CHARACTER_GENERATION')
  expect.equal(defaultAuthorityForKind('tool_output'), 'TOOL_OBSERVATION')
  expect.equal(defaultAuthorityForKind('system_instruction'), 'SYSTEM_INSTRUCTION')
})

test('provenance 记下 actor / transport / reply，且 transport 不参与权威判定', () => {
  const provenance = buildProvenance({
    actorType: 'user',
    actorId: 'u-1',
    transport: 'qq',
    replyToEventId: 'cev:a:b:1',
  })
  expect.equal(provenance.transport, 'qq')
  expect.equal(provenance.replyToEventId, 'cev:a:b:1')
  expect.equal(provenance.authority, 'USER_EXPLICIT')
  // transport 变了，权威等级不该变 —— 计划书第 25 节
  const wechat = buildProvenance({ actorType: 'user', actorId: 'u-1', transport: 'wechat' })
  expect.equal(wechat.authority, provenance.authority)
})

// ===========================================================================
group('对话完整性 :: 序号')
// ===========================================================================

test('会话内序号必须从 1 开始、只能 +1', () => {
  expect.equal(validateConversationSequence({ incoming: 1, currentMax: 0 }).kind, 'accept')
  expect.equal(validateConversationSequence({ incoming: 2, currentMax: 1 }).kind, 'accept')
})

test('跳号被拒绝（会话内序号是"说到第几句"的可读账）', () => {
  const verdict = validateConversationSequence({ incoming: 5, currentMax: 1 })
  expect.equal(verdict.kind, 'reject')
  expect.equal((verdict as { code: string }).code, 'conversation_sequence_gap')
})

test('已占用的序号是幂等命中，不是错误（重试必须能成功）', () => {
  const verdict = validateConversationSequence({ incoming: 3, currentMax: 3 })
  expect.equal(verdict.kind, 'duplicate')
})

test('非法序号（0 / 负数 / 非整数）被拒绝', () => {
  for (const bad of [0, -1, 1.5]) {
    const verdict = validateConversationSequence({ incoming: bad, currentMax: 0 })
    expect.equal(verdict.kind, 'reject', `序号 ${bad} 必须被拒绝`)
  }
})

// ===========================================================================
group('对话完整性 :: 会话归属（T2 / T10）')
// ===========================================================================

test('会话与角色必须与期望一致（换会话不等于换角色）', () => {
  expect.equal(
    validateParticipants({
      characterId,
      conversationId,
      expectedCharacterId: characterId,
      expectedConversationId: conversationId,
    }).kind,
    'accept'
  )
})

test('事件跨角色 → 拒绝', () => {
  const verdict = validateParticipants({
    characterId: asCharacterId('char_other'),
    conversationId,
    expectedCharacterId: characterId,
    expectedConversationId: conversationId,
  })
  expect.equal(verdict.kind, 'reject')
  expect.equal((verdict as { code: string }).code, 'character_mismatch')
})

test('事件跨会话 → 拒绝', () => {
  const verdict = validateParticipants({
    characterId,
    conversationId: otherConversationId,
    expectedCharacterId: characterId,
    expectedConversationId: conversationId,
  })
  expect.equal((verdict as { code: string }).code, 'conversation_mismatch')
})

// ===========================================================================
group('对话完整性 :: reply graph（计划书第 34 节）')
// ===========================================================================

const target = (overrides: Partial<Parameters<typeof validateReplyGraph>[0]['target']> = {}) => ({
  id: asConversationEventId('cev:char_test:dm-test:1'),
  characterId,
  conversationId,
  sequence: 1,
  actorType: 'user' as ActorType,
  ...overrides,
})

test('assistant 事件没有 replyToEventId → 拒绝（无法回答"在回应什么"）', () => {
  const verdict = validateReplyGraph({
    type: 'assistant_message',
    characterId,
    conversationId,
    sequence: 2,
  })
  expect.equal((verdict as { code: string }).code, 'reply_target_required')
})

test('用户事件可以不回复任何东西（但一旦给了就必须对）', () => {
  expect.equal(
    validateReplyGraph({ type: 'user_message', characterId, conversationId, sequence: 2 }).kind,
    'accept'
  )
})

test('回复目标不存在 → 拒绝（悬空的 reply graph 会污染证据链）', () => {
  const verdict = validateReplyGraph({
    type: 'assistant_message',
    replyToEventId: asConversationEventId('cev:char_test:dm-test:99'),
    characterId,
    conversationId,
    sequence: 2,
  })
  expect.equal((verdict as { code: string }).code, 'reply_target_missing')
})

test('回复目标属于别的角色 / 别的会话 → 拒绝', () => {
  expect.equal(
    (
      validateReplyGraph({
        type: 'assistant_message',
        replyToEventId: target().id,
        target: target({ characterId: asCharacterId('char_other') }),
        characterId,
        conversationId,
        sequence: 2,
      }) as { code: string }
    ).code,
    'reply_target_foreign_character'
  )
  expect.equal(
    (
      validateReplyGraph({
        type: 'assistant_message',
        replyToEventId: target().id,
        target: target({ conversationId: otherConversationId }),
        characterId,
        conversationId,
        sequence: 2,
      }) as { code: string }
    ).code,
    'reply_target_other_conversation'
  )
})

test('回复目标不比本事件更早 → 拒绝', () => {
  const verdict = validateReplyGraph({
    type: 'assistant_message',
    replyToEventId: target({ sequence: 5 }).id,
    target: target({ sequence: 5 }),
    characterId,
    conversationId,
    sequence: 5,
  })
  expect.equal((verdict as { code: string }).code, 'reply_target_not_earlier')
})

test('合法的 reply 被接受', () => {
  expect.equal(
    validateReplyGraph({
      type: 'assistant_message',
      replyToEventId: target().id,
      target: target(),
      characterId,
      conversationId,
      sequence: 2,
    }).kind,
    'accept'
  )
})

// ===========================================================================
group('对话完整性 :: actor 一致性')
// ===========================================================================

test('actor 一致性给出稳定错误码（供上层区分"哪条规则"被破）', () => {
  const verdict = validateActorConsistency({ type: 'user_message', actorType: 'character' })
  expect.equal(verdict.kind, 'reject')
  expect.equal((verdict as { code: string }).code, 'actor_type_mismatch')
})

test('未登记的事件类型被拒绝', () => {
  const verdict = validateActorConsistency({
    type: 'unknown_type' as ConversationEventType,
    actorType: 'user',
  })
  expect.equal((verdict as { code: string }).code, 'unknown_event_type')
})

// ===========================================================================
group('对话完整性 :: 组合校验')
// ===========================================================================

test('组合校验：合法写入被接受', () => {
  const verdict = validateIntegrity({
    type: 'user_message',
    actorType: 'user',
    characterId,
    conversationId,
    expectedCharacterId: characterId,
    expectedConversationId: conversationId,
    conversationSequence: 2,
    currentMaxConversationSequence: 1,
    sequence: 3,
  })
  expect.equal(verdict.kind, 'accept')
})

test('组合校验：幂等优先于其余检查（重复写不是错误）', () => {
  const verdict = validateIntegrity({
    type: 'user_message',
    actorType: 'user',
    characterId,
    conversationId,
    expectedCharacterId: characterId,
    expectedConversationId: conversationId,
    conversationSequence: 1,
    currentMaxConversationSequence: 1,
    // 即使 actor 也不对，也应当先报 duplicate —— 因为"重试"的语义
    // 比"这一条写错了"更常见，而错误码会影响上层的处理方式
    sequence: 2,
  })
  expect.equal(verdict.kind, 'duplicate')
})

// ===========================================================================
group('对话完整性 :: 归一化（计划书第 23–25 节）')
// ===========================================================================

const resolver = {
  resolveCharacter: (ref: string | undefined) => ref ?? 'char_sumuwei',
  resolveConversation: (_c: string, ref: string | undefined) => ref ?? 'dm-default',
  resolveUser: (input: { transport?: string; externalId?: string }) =>
    input.externalId ? `user-${input.externalId}` : undefined,
}

test('归一化把 transport 身份解析成领域身份', async () => {
  const normalized = await normalizeConversationInput(
    {
      sender: { actorType: 'user', externalId: 'qq-12345', displayName: 'Alex' },
      content: '  你好  ',
      transport: 'qq',
    },
    { resolver }
  )
  expect.equal(normalized.actor.actorId, 'user-qq-12345')
  expect.equal(normalized.content, '你好', '内容必须 trim')
  expect.equal(normalized.transport, 'qq')
  expect.equal(String(normalized.characterId), 'char_sumuwei')
})

test('transport 身份只作为元数据保留，绝不冒充领域身份（计划书第 25 节）', async () => {
  const normalized = await normalizeConversationInput(
    { sender: { actorType: 'user', externalId: 'qq-12345' }, content: '你好', transport: 'qq' },
    { resolver }
  )
  expect.notOk(
    String(normalized.actor.actorId) === 'qq-12345',
    'qq_id 不能直接当 UserId —— 换平台就不再是同一个人了'
  )
  expect.equal(normalized.metadata?.transportActorId, 'qq-12345')
})

test('身份解析失败 → 拒绝，而不是猜一个（凭空造 UserId 会把一个人劈成两半）', async () => {
  let error: KernelError | undefined
  try {
    await normalizeConversationInput(
      { sender: { actorType: 'user' }, content: '你好' },
      { resolver }
    )
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'actor_unresolved')
})

test('空正文被拒绝', async () => {
  let error: KernelError | undefined
  try {
    await normalizeConversationInput(
      { sender: { actorType: 'user', externalId: 'x' }, content: '  ' },
      { resolver }
    )
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'empty_message')
})

test('系统与工具身份不经过用户映射表（它们的 id 就是组件名）', async () => {
  const system = await normalizeConversationInput(
    { sender: { actorType: 'system', externalId: 'scheduler' }, content: '系统通知' },
    {
      resolver: {
        ...resolver,
        resolveUser: () => undefined, // 即使用户解析器失效也不该影响系统事件
      },
    }
  )
  expect.equal(system.actor.actorId, 'scheduler')
})

test('同一 (transport, externalId) 反复归一化得到同一个 UserId', async () => {
  const first = await normalizeConversationInput(
    { sender: { actorType: 'user', externalId: 'A' }, content: '一' },
    { resolver }
  )
  const second = await normalizeConversationInput(
    { sender: { actorType: 'user', externalId: 'A' }, content: '二' },
    { resolver }
  )
  expect.equal(first.actor.actorId, second.actor.actorId)
})

test('不同会话的同一用户得到同一个 UserId（计划书 T2 的领域侧保证）', async () => {
  const a = await normalizeConversationInput(
    {
      sender: { actorType: 'user', externalId: 'A' },
      content: '一',
      conversationRef: 'dm-A',
    },
    { resolver }
  )
  const b = await normalizeConversationInput(
    {
      sender: { actorType: 'user', externalId: 'A' },
      content: '二',
      conversationRef: 'dm-B',
    },
    { resolver }
  )
  expect.equal(a.actor.actorId, b.actor.actorId, '换会话不该换人')
  expect.notOk(
    String(a.conversationId) === String(b.conversationId),
    '会话 id 必须不同（否则 T2 测的不是隔离）'
  )
  expect.equal(String(a.characterId), String(b.characterId), '角色当然也不变')
})

// ===========================================================================
group('对话完整性 :: 此刻的挂钟时间（M5.5.1 WP6）')
// ===========================================================================

/**
 * 2026-09-20 21:15（东八区）= 13:15 UTC，星期日。
 *
 * 用固定 epoch 而不是 `Date.now()`：判据必须永远可复现，否则它会在某天
 * 因为"跑测试时恰好是几点"而变成假信号。
 */
const CLOCK_FIXED_EPOCH_MS = Date.UTC(2026, 8, 20, 13, 15)

/**
 * 用**与主链路同一个** `buildContextCompilerV2` 装配一轮，取回 clock section。
 *
 * 刻意不自己拼 provider 列表：那样测到的是"我以为的装配"，不是她真正读到的装配。
 * 输入复用 M3.5 基线那两条合成对话（它们唯一的用途就是当固定输入）。
 */
async function clockSections(clockEpochMs: number | undefined): Promise<ContextSection[]> {
  const identity = baselineIdentity()
  const compiler = buildContextCompilerV2({
    identity,
    definition: identity.definition,
    recentLimit: 16,
    ...(clockEpochMs !== undefined ? { clockEpochMs } : {}),
  })
  const packet = await compiler.compile({
    characterId: identity.characterId,
    currentInput: BASELINE_CURRENT_INPUT,
    recentEvents: BASELINE_RECENT_LINES as readonly ConversationLine[],
    now: CLOCK_FIXED_EPOCH_MS,
  })
  return packet.sections.filter((s) => s.id === 'clock')
}

const clockSectionIds = async (clockEpochMs: number | undefined): Promise<string[]> =>
  (await clockSections(clockEpochMs)).map((s) => s.id)

test('renderClockBlock：年月日 + 星期 + 钟点都来自那一刻（不读宿主 locale）', () => {
  const text = renderClockBlock(CLOCK_FIXED_EPOCH_MS)
  expect.ok(text.includes('2026-09-20'), '缺日期')
  expect.ok(text.includes('星期日'), '缺星期')
  expect.ok(text.includes('21:15'), '缺钟点（东八区换算）')
  expect.ok(text.includes('东八区'), '必须写明时区，否则模型无法知道该按哪个钟点说')
})

test('renderClockBlock 对 UTC 日界两侧给出**不同**的日期（负控：证明换算真的生效）', () => {
  // 2026-09-20 07:30 UTC = 2026-09-20 15:30 CST → 同一天
  const beforeMidnight = renderClockBlock(Date.UTC(2026, 8, 20, 7, 30))
  // 2026-09-20 16:30 UTC = 2026-09-21 00:30 CST → 跨到了下一天
  const afterMidnight = renderClockBlock(Date.UTC(2026, 8, 20, 16, 30))
  expect.includes(beforeMidnight, '2026-09-20 星期日 15:30', '日界前的换算不对')
  expect.includes(afterMidnight, '2026-09-21 星期一 00:30', '日界后的换算不对')
  expect.notIncludes(
    afterMidnight,
    '16:30',
    '这条是负控：如果换算没生效（直接拿 UTC 当本地时间），这里就会写成 16:30'
  )
})

test('时钟 section：不可省略地写进 prompt，且引用里带着那一刻的 epoch', async () => {
  const sections = await clockSections(CLOCK_FIXED_EPOCH_MS)
  const content = sections.map((s) => s.content).join('\n')
  expect.ok(content.includes('2026-09-20'), 'prompt 里没有日期')
  expect.ok(content.includes('21:15'), 'prompt 里没有钟点')
  expect.ok(
    (sections[0]?.sourceRefs ?? []).includes(`clock:${CLOCK_FIXED_EPOCH_MS}`),
    '没有留下可审计的时刻引用（Trace 要能回答"她那一轮以为现在是几点"）'
  )
})

test('不传时刻 ⇒ 一条 section 都不加（负控：合成轮次 / M3.5 基线不受影响）', async () => {
  const withClock = await clockSectionIds(CLOCK_FIXED_EPOCH_MS)
  const without = await clockSectionIds(undefined)
  expect.equal(withClock.length, 1, '传了时刻就该恰好产 1 条 clock section')
  expect.equal(without.length, 0, '不传时刻就该产 0 条 —— 否则基线会被静悄悄改掉')
})

test('clock section 的声明与契约一致（kind / priority / droppable）', async () => {
  const sections = await clockSections(CLOCK_FIXED_EPOCH_MS)
  expect.equal(sections[0]?.kind, 'clock')
  expect.equal(sections[0]?.priority, SECTION_PRIORITY.clock)
  expect.equal(sections[0]?.droppable, true, '它不是硬保留（硬保留只有身份/规则/当前输入那几条）')
  expect.ok(
    (sections[0]?.priority ?? 0) < SECTION_PRIORITY.criticalState,
    '时钟必须排在状态之后（状态是 60）'
  )
  expect.ok(
    (sections[0]?.priority ?? 0) > SECTION_PRIORITY.memory,
    '时钟必须排在长期记忆之前：预算不够时先裁记忆'
  )
})

// ---------------------------------------------------------------------------
const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, '对话完整性测试（M3 WP5/WP6）')
process.exit(summary.failed === 0 ? 0 : 1)
