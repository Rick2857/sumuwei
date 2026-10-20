/**
 * M3.5 Future Compatibility 测试（FC-T01 ~ FC-T08）。
 *
 * ============================================================================
 *  这些**不是** Lv3 功能测试，而是 Schema / Contract 测试（计划书第 74 节）
 * ============================================================================
 * 计划书第 74 节写得很清楚：
 *
 *   > 这些不是 Lv3 功能测试。只是 Schema/Contract Test。
 *
 * 因此本文件的每一个用例都在回答同一个问题：
 *
 *     **"我们的接口以后接得上吗？"**
 *
 * 而不是"世界模拟做出来了吗"。它**不碰数据库、不碰模型、不碰 ElizaOS**
 * （唯一需要落库的那一条 FC-T03 落库分支放在 `m3.5:verify` 里用沙箱库跑），
 * 全部 deterministic、毫秒级 —— 这是"每次改动都能跑"的前提。
 *
 * 用例与计划书第 75–82 节的对应关系：
 *
 *   FC-T01 Second Entity              第 75 节
 *   FC-T02 Non-Conversation Observation 第 76 节
 *   FC-T03 Speech Intent              第 77 节
 *   FC-T04 Intent != Result           第 78 节
 *   FC-T05 Perspective                第 79 节
 *   FC-T06 Time                       第 80 节
 *   FC-T07 Trigger                    第 81 节
 *   FC-T08 Current Regression         第 82 节
 *
 * 跑法：
 *   pnpm m3.5:test
 *   pnpm m3.5:test FC-T04        # 只跑名字含它的
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import {
  DOMAIN_EVENT_SCOPE,
  KernelError,
  M3_5_ACTIVE_ENTITY_KINDS,
  M3_5_ALLOWS_LOGICAL_TIME,
  M3_5_ENABLED_TRIGGER_KINDS,
  M3_5_PRODUCIBLE_INTENT_TYPES,
  M3_5_PRODUCIBLE_OBSERVATION_TYPES,
  M3_5_RESERVED_ENTITY_KINDS,
  M3_5_RESERVED_TRIGGER_KINDS,
  assertCharacterInternalScope,
  assertM3_5OutputInvariant,
  assertTriggerEnabledInM3_5,
  asCharacterId,
  asConversationEventId,
  asConversationId,
  asEntityId,
  asIntentId,
  asObservationId,
  characterTurnContextOf,
  conversationContentOf,
  conversationObservationFrom,
  createCharacterIntent,
  createConversationEvent,
  createObservation,
  createSpeechIntent,
  deriveCurrentInput,
  entityRef,
  entityRefEquals,
  assertEventTime,
  eventTimeOf,
  fromActor,
  intentResolutionOf,
  isProducibleInM3_5,
  isRenderableAsInput,
  singleSpeechOutput,
  speechPayloadOf,
  toActorRef,
  triggerKindOf,
  triggerOf,
  BELIEF_DOMAIN_EVENT_TYPES,
  BELIEF_INFERRED_VALUES,
  beliefSlotKeyOf,
  createBeliefDomainEventRegistry,
  isBeliefReportedEligible,
  makeBeliefId,
  type CharacterIntent,
  type CharacterTurnContext,
  type EntityRef,
  type Observation,
  type PerspectiveOwnerId,
  type TriggerKind,
} from '../src/kernel/contracts/index.ts'
import {
  createConversationIntentResolver,
} from '../src/infrastructure/runtime/conversation-intent-resolver.ts'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'
import { BASELINE_META_FILE, BASELINE_PROMPT_FILE, BASELINE_FIXTURE_DIR, buildBaselinePrompt } from './m3.5-prompt-baseline.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SUMUWEI = asCharacterId('char_sumuwei')
const CHARACTER_B = asCharacterId('char_B')
const CONVERSATION = asConversationId('dm-sumuwei-b8ec0760')

/** 造一条真实形状的用户事件（走 createConversationEvent，因此有 provenance） */
function userEventFor(characterId = SUMUWEI, text = '你还记得我们第一次见面吗？') {
  return createConversationEvent({
    characterId,
    conversationId: CONVERSATION,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: 'user-alex',
    content: text,
    sequence: 1,
  })
}

/**
 * 去掉注释（用于"代码里不许出现某符号"的静态守卫）。
 *
 * 只做够用的处理：块注释 + 行注释。不做完整的词法分析 ——
 * 这条守卫的目的是拦住"有人真的写了 WorldStateRepository 这个类"，
 * 而不是拦住某条字符串里恰好出现这个词。因此宁可略微宽松。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      return index === -1 ? line : line.slice(0, index)
    })
    .join('\n')
}

// ===========================================================================
group('FC-T01 第二个实体（计划书第 75 节）')
// ===========================================================================

test('EntityRef 可以表示第二个角色（不需要改任何底层 ID 类型）', () => {
  const sumuwei = entityRef('character', String(SUMUWEI))
  const characterB = entityRef('character', String(CHARACTER_B))

  expect.notOk(entityRefEquals(sumuwei, characterB), '两个角色必须是两个不同的实体')
  expect.equal(characterB.kind, 'character')
  expect.equal(String(characterB.id), 'char_B')

  // "苏沐薇 → 角色 B"这种关系在类型上必须写得出来（未来 M7 Relationship）
  const relation = { owner: asEntityId(String(SUMUWEI)), target: asEntityId(String(CHARACTER_B)) }
  expect.notOk(
    String(relation.owner) === String(relation.target),
    'owner 与 target 可以是两个不同的角色 —— 这正是 EntityRef 存在的理由'
  )
})

test('同一个 id 配不同 kind 不相等（角色 "kitchen" 与地点 kitchen 必须能区分）', () => {
  const asCharacter = entityRef('character', 'kitchen')
  const asLocation = entityRef('location', 'kitchen')
  expect.notOk(
    entityRefEquals(asCharacter, asLocation),
    '只比 id 会让"叫 kitchen 的角色"和"厨房"在数据上变成同一个东西'
  )
})

test('ActorRef ↔ EntityRef 两个方向都可用，且非法方向失败关闭', () => {
  const actor = { actorId: 'user-alex', actorType: 'user' as const }
  const entity = fromActor(actor)
  expect.equal(entity.kind, 'user')
  expect.equal(String(entity.id), 'user-alex')
  expect.deepEqual(toActorRef(entity), actor, '往返必须是恒等映射（这也是选小写枚举的收益）')

  // 非 actor 实体不能冒充发言者
  let error: KernelError | undefined
  try {
    toActorRef(entityRef('location', 'loc_kitchen'))
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(
    error?.code,
    'entity_kind_not_an_actor',
    '地点不能当发言者：把地点硬塞成 system，是来源伪造的另一种形式'
  )
})

test('EntityKind 的扩展位已登记但 M3.5 不产出它们', () => {
  expect.equal(M3_5_ACTIVE_ENTITY_KINDS.length, 4, 'M3.5 只启用 user / character / system / tool')
  expect.atLeast(M3_5_RESERVED_ENTITY_KINDS.length, 3, '未来实体种类必须已经登记（枚举扩展能力）')
  for (const kind of M3_5_RESERVED_ENTITY_KINDS) {
    expect.notOk(
      (M3_5_ACTIVE_ENTITY_KINDS as readonly string[]).includes(kind),
      `${kind} 只登记、不启用`
    )
  }

  // 未登记的 kind 必须被拒绝，而不是当成"某种字符串"
  let error: KernelError | undefined
  try {
    entityRef('spaceship' as never, 'x')
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'unknown_entity_kind')
})

test('第二个角色能写出自己的对话事件（多角色兼容性检查）', () => {
  const event = createConversationEvent({
    characterId: CHARACTER_B,
    conversationId: asConversationId('dm-b-1'),
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: 'user-other',
    content: '你好。',
    sequence: 1,
  })
  expect.equal(String(event.characterId), 'char_B')
  expect.equal(event.sourceKind, 'user_statement', '第二个角色的来源语义与第一个完全一致')
})

// ===========================================================================
group('FC-T02 非对话观测（计划书第 76 节）')
// ===========================================================================

test('“灯熄灭了”可以作为 Observation 进入 Kernel，**不必**伪装成用户消息', () => {
  /*
   * 计划书第 76 节举的例子是 `type=ENVIRONMENT_TEST`；
   * 这里用已登记的 `ENVIRONMENT_OBSERVATION`（它本来就是为这类输入准备的），
   * 并把测试标签放进 metadata —— 不为了一个测试在生产枚举里塞假值。
   * 意图完全一致：**非对话输入不需要伪装**。
   *
   * 计划书第 76 节要的验收标准是「确认 Character API 可以接收。
   * 但不要求模型实际处理」—— 因此这里断言的是**边界**：
   * 观测能被构造、能被 TurnContext 接收，且**没有**被当成一句用户话。
   */
  const observation = createObservation({
    characterId: SUMUWEI,
    source: entityRef('system', 'environment'),
    type: 'ENVIRONMENT_OBSERVATION',
    content: '房间的灯突然熄灭了。',
    recordedAt: 1_760_000_000_000,
    metadata: { testTag: 'ENVIRONMENT_TEST' },
  })

  expect.equal(observation.type, 'ENVIRONMENT_OBSERVATION')
  expect.equal(observation.sourceEventIds.length, 0, '环境观测没有来源对话事件 —— 这正是它不伪装的原因')

  // Kernel 的输入上下文**接收**它：不是"必须给一句用户文本"
  const turnContext: CharacterTurnContext = characterTurnContextOf({
    characterId: SUMUWEI,
    observation,
    conversationId: CONVERSATION,
  })
  expect.equal(turnContext.observation?.type, 'ENVIRONMENT_OBSERVATION')
  expect.equal(
    turnContext.currentInput,
    undefined,
    '非对话观测没有"当前输入文本"：它不该被渲染成"对方刚刚说"'
  )
})

test('非对话观测不能夹带一句用户文本（伪装在运行期走不通）', () => {
  const observation = createObservation({
    characterId: SUMUWEI,
    source: entityRef('system', 'environment'),
    type: 'ENVIRONMENT_OBSERVATION',
    content: '房间的灯突然熄灭了。',
    recordedAt: 1,
  })

  let error: KernelError | undefined
  try {
    characterTurnContextOf({
      characterId: SUMUWEI,
      observation,
      // 这正是"把世界事件伪装成用户消息"的写法
      currentInput: '房间的灯突然熄灭了。',
    })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(
    error?.code,
    'observation_not_renderable_as_input',
    '计划书第 13 节：世界事件只能伪装成用户消息进入 —— 这个伪装点必须被关掉'
  )
  expect.notOk(isRenderableAsInput(observation), '它还不能被渲染进 prompt（那是后续阶段的事）')
})

test('非对话观测不会被渲染成"用户刚刚说"（deriveCurrentInput 失败关闭）', () => {
  const observation = createObservation({
    characterId: SUMUWEI,
    source: entityRef('system', 'environment'),
    type: 'ENVIRONMENT_OBSERVATION',
    content: '房间的灯突然熄灭了。',
    recordedAt: 1,
  })

  let error: KernelError | undefined
  try {
    deriveCurrentInput(observation)
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(
    error?.code,
    'observation_not_renderable_as_input',
    '把"灯熄灭了"渲染成用户说的一句话，正是 Observation 要阻止的那种伪装'
  )
})

test('对话观测由事件**确定性派生**，并且不是事实（计划书第 14 节）', () => {
  const event = userEventFor()
  const a = conversationObservationFrom(event)
  const b = conversationObservationFrom(event)

  expect.equal(String(a.id), String(b.id), '同一条事件必须永远得到同一个 Observation id（可重放）')
  expect.equal(a.type, 'CONVERSATION_OBSERVATION')
  expect.deepEqual(a.sourceEventIds, [String(event.id)])
  expect.equal(a.source.kind, 'user', '"谁把这条信息带进她的感知范围"必须记下来')

  const content = conversationContentOf(a)
  expect.equal(content.text, event.content)

  // 第 14 节：Observation 是"某人说了 X"，不是"X 为真"
  const hearsay = conversationObservationFrom(userEventFor(SUMUWEI, '门外没人。'))
  expect.equal(
    conversationContentOf(hearsay).text,
    '门外没人。',
    '观测记录的是"某人说了这句话"，而不是"门外真的没人"'
  )
})

test('未登记的观测类型被拒绝（受控登记表）', () => {
  let error: KernelError | undefined
  try {
    createObservation({
      characterId: SUMUWEI,
      source: entityRef('system', 'x'),
      type: 'MAGIC_OBSERVATION' as never,
      content: 'x',
      recordedAt: 1,
    })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'unknown_observation_type')
  expect.equal(M3_5_PRODUCIBLE_OBSERVATION_TYPES.length, 1, 'M3.5 真正产出的只有对话观测')
})

// ===========================================================================
group('FC-T03 Speech Intent（计划书第 77 节）')
// ===========================================================================

test('普通聊天的输出是 CharacterOutput └─ SpeechIntent，且行为与 M3 一致', () => {
  const observation = conversationObservationFrom(userEventFor())
  const intent = createSpeechIntent({
    characterId: SUMUWEI,
    text: '记得。',
    target: entityRef('user', 'user-alex'),
    sourceObservationIds: [observation.id],
  })

  const output = singleSpeechOutput(intent)
  expect.equal(output.intents.length, 1, '计划书第 19 节：M3.5 恒为恰好一条 intent')
  assertM3_5OutputInvariant(output)

  const payload = speechPayloadOf(intent)
  expect.equal(payload?.text, '记得。')
  expect.equal(String(payload?.target?.id), 'user-alex', 'target 是 EntityRef —— 未来可以对角色 B 说')

  // 领域边界上不再是 string（计划书第 70 节）
  expect.ok(typeof output === 'object' && !Array.isArray(output), '对外是 CharacterOutput，不是裸 string')
})

test('SpeechIntent 经 ConversationIntentResolver 变成一条 assistant 事件', async () => {
  const intent = createSpeechIntent({ characterId: SUMUWEI, text: '在的。' })
  const observation = conversationObservationFrom(userEventFor())

  /*
   * 用**内存记录器**替身：这条用例要证的是"Intent → Result"的形状，
   * 而不是 SQL（SQL 那一条由 `pnpm m3.5:verify` 在沙箱库上跑）。
   */
  const written: { text: string; sequence: number; characterSequence: number }[] = []
  const resolver = createConversationIntentResolver({
    recorder: {
      recordAssistantMessageOutcome: async (input: {
        text: string
        conversationSequence: number
        characterSequence: number
      }) => {
        written.push({
          text: input.text,
          sequence: input.conversationSequence,
          characterSequence: input.characterSequence,
        })
        return {
          appended: true,
          skipped: false,
          event: {
            id: asConversationEventId('cev:char_sumuwei:dm-sumuwei-b8ec0760:2'),
            characterId: SUMUWEI,
            conversationId: CONVERSATION,
            sequence: 2,
            conversationSequence: 2,
            type: 'assistant_message',
            actorType: 'character',
            actorId: String(SUMUWEI),
            content: input.text,
            sourceKind: 'character_output',
            sourceAuthority: 'CHARACTER_GENERATION',
            epistemicSource: 'character_generation',
            schemaVersion: 1,
            createdAt: 1,
          },
        }
      },
    } as never,
    conversationSequence: 2,
    characterSequence: 2,
    replyToEventId: observation.sourceEventIds[0] as never,
    now: () => 1,
  })

  const resolution = await resolver.resolve(intent)
  expect.equal(resolution.status, 'accepted')
  expect.equal(resolution.resultRefs?.length, 1, '结果以**引用**的形式给出，而不是把事件整个塞进 resolution')
  expect.equal(
    String(resolution.resultRefs?.[0]),
    'cev:char_sumuwei:dm-sumuwei-b8ec0760:2'
  )
  expect.equal(written.length, 1, '恰好落一条')
  expect.equal(written[0].text, '在的。', '落库的正文就是 intent 的正文')
  expect.equal(String(resolution.intentId), String(intent.id), 'resolution 必须指回它的 intent')
})

test('M3.5 的输出不变量会拦住非 SPEECH / 多条 intent（运行期守住"这个阶段不做"）', () => {
  const action = createCharacterIntent({
    characterId: SUMUWEI,
    type: 'ACTION',
    payload: { action: 'OPEN_DOOR' },
  })
  let error: KernelError | undefined
  try {
    assertM3_5OutputInvariant({ intents: [action] })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'm3_5_output_intent_not_supported')
  expect.deepEqual([...M3_5_PRODUCIBLE_INTENT_TYPES], ['SPEECH'])

  const two = singleSpeechOutput(createSpeechIntent({ characterId: SUMUWEI, text: 'a' }))
  two.intents.push(createSpeechIntent({ characterId: SUMUWEI, text: 'b' }))
  let multiError: KernelError | undefined
  try {
    assertM3_5OutputInvariant(two)
  } catch (e) {
    multiError = e as KernelError
  }
  expect.equal(multiError?.code, 'm3_5_output_must_be_single_intent')
})

// ===========================================================================
group('FC-T04 Intent ≠ Result（计划书第 78 节）')
// ===========================================================================

test('MockActionIntent 不会自动产生任何世界状态变更', async () => {
  const action = createCharacterIntent({
    characterId: SUMUWEI,
    type: 'ACTION',
    payload: { action: 'OPEN_DOOR', target: 'loc_door' },
  })

  // 一个"世界"哨兵：如果 Intent 会自动改世界，它必然在这里被改动
  const world = { doorOpen: false, keysInBox: true }
  const before = JSON.stringify(world)

  // 假的"环境"：明确拒绝（门锁着）。这正是 FC-03 要求的第三条路径。
  const environment = {
    name: 'mock-environment',
    async resolve(intent: CharacterIntent) {
      return intentResolutionOf(intent.id, 'rejected', {
        reason: 'door_locked',
        resolvedAt: 1,
      })
    },
  }

  const resolution = await environment.resolve(action)
  expect.equal(resolution.status, 'rejected', 'rejected 是**正常结果**，不是故障')
  expect.equal(resolution.resultRefs?.length ?? 0, 0, '被拒绝的 intent 不产生任何结果引用')
  expect.equal(JSON.stringify(world), before, 'Intent 自己绝不能改世界（否则"她想什么世界就发生什么"）')
})

test('Intent 的 payload 只描述"想做什么"，不含"做成了什么"', () => {
  const action = createCharacterIntent({
    characterId: SUMUWEI,
    type: 'ACTION',
    payload: { action: 'OPEN_DOOR' },
  })
  const keys = Object.keys(action.payload as Record<string, unknown>)
  expect.deepEqual(keys, ['action'], 'payload 里只有意图本身：没有 result / success / worldState 这类字段')
  expect.ok(action.id !== undefined && action.createdAt !== undefined)
})

test('世界/故事实现只允许住在具名模块边界内（阶段锁 → 模块边界锁；ADR-091 §2）', () => {
  /*
   * 计划书第 102 节给过一条**失控停止条件**：
   *
   *   > 如果开发过程中出现 SceneService / WorldStateRepository / NPCService /
   *   > SimulationScheduler，立即停止。
   *
   * M3.5 把它写成"`src/**` 里不得出现这些符号"。**后 Lv2（ADR-091 §2）把这条阶段锁
   * 演进为模块边界锁**：世界是真的要建了，所以判据从"世界不存在"变成
   * "世界只能住在被具名的模块里，且不得成为伪装通道"。
   *
   * ⚠️ 这次演进**必须**保持：
   *   · 退役的是"世界不存在"这一条**阶段**断言（它的使命已完成）；
   *   · **没有**退役 scope 校验、没有退役"世界事实不得伪装成对话/角色内部事件"的负控；
   *   · 未被登记的**新**世界/场景/NPC/调度器符号仍然必须让本门失败（见下面的 IMPL 扫描）。
   *
   * 扫描**代码**而不是注释：M3.5 的文档与类型注释里大量出现"不建 WorldEvent"这类
   * **否定式说明**，如果连注释一起扫，这条守卫会把自己的说明文字判成违规
   * （第一次跑它就真的这么失败了）。
   */

  /** 允许出现世界/故事实现的目录（白名单；新增必须改 ADR-091 §2 并同步这里） */
  const ALLOWED_WORLD_DIRS = [
    'src/kernel/storyline/',
    'src/infrastructure/storyline/',
    'src/kernel/app/storyline/',
  ]

  // ADR-091 §2.1：ADR-094 已批准的生产资产与装配依赖；不授予世界实现目录资格。
  const STORY_TYPES = 'src/kernel/storyline/story-types.ts'
  const REGISTERED_STORY_IMPORTS: Record<string, readonly string[]> = {
    'src/content/storyline/jichuang-interview-two/story-pack.ts': [STORY_TYPES],
    'src/content/storyline/jichuang-interview-two/render.ts': [STORY_TYPES],
    'src/infrastructure/runtime/story-cognition.ts': [
      STORY_TYPES,
      'src/kernel/app/storyline/state-evaluators.ts',
      'src/kernel/app/storyline/consumer-loop.ts',
      'src/kernel/app/storyline/choice-ingest.ts',
      /* ⚠️ 2026-10-05（`ADR-107` `R-1b`）：同轮"选择解析"的编排与端口形状就住在这一层 */
      'src/kernel/app/storyline/choice-turn.ts',
      'src/kernel/app/storyline/daily-turn.ts',
      'src/kernel/storyline/world-observation.ts',
      'src/kernel/app/storyline/choice-decision.ts',
      /* ⚠️ 2026-10-05（复核项 ②）：CLI 会话引用由这一层拼（`main.ts` 不许碰故事边界） */
      'src/kernel/app/storyline/run-lifecycle.ts',
      'src/infrastructure/storyline/store/story-ledger-store.ts',
      'src/infrastructure/storyline/store/story-watermark-store.ts',
      'src/content/storyline/jichuang-interview-two/render.ts',
    ],
    'src/infrastructure/runtime/story-withdraw-command.ts': [
      'src/kernel/app/storyline/admin.ts',
      'src/infrastructure/storyline/store/story-ledger-store.ts',
    ],
    /*
     * ⚠️ **2026-10-05 追加**（`L-S8-30` `ADR-107`）：`story:start` 的执行体与
     * `story-withdraw-command.ts` **同形**（都是"生产入口的 DB 侧"）⇒ 按同一条纪律登记它自己的边界。
     */
    'src/infrastructure/runtime/story-start-command.ts': [
      'src/kernel/app/storyline/admin.ts',
      'src/kernel/app/storyline/run-lifecycle.ts',
      'src/infrastructure/storyline/store/story-ledger-store.ts',
      'src/content/storyline/jichuang-interview-two/story-pack.ts',
    ],
    /*
     * ⚠️ **2026-10-05**（`ADR-107` `R-1b`）：`main.ts` 的故事边界**没有**扩大 ——
     * 它的负控（本组后面的 `rejected` 表）拿
     * `src/main.ts` + `story-ledger-store.ts` 的合成 import 当反例，
     * 而实现时**故意**让 `main.ts` 只多调一个方法（`story-cognition.ts` 的
     * `resolveChoiceTurn`），**不**自己建账本端口 ⇒ 这份名单**保持原样**。
     * 这是判据在起作用的例子：第一版实现真把账本 SQL 适配器拉进了 `main.ts`，
     * 就是这条负控把它挡下来的。
     */
    // Opt-in entry owns the content dependency; main has no eager story dependency.
    'src/features/lv25/index.ts': ['src/content/storyline/jichuang-interview-two/story-pack.ts'],
  }

  /**
   * 世界/场景/NPC/调度器符号。
   *
   * `WorldKernel` **刻意保留在黑名单里**：`Storyline` 是有限故事运行器，
   * 不是万能世界内核；ADR-091 §2 没有放行它。
   */
  const WORLD_SYMBOLS = [
    'WorldStateRepository',
    'SceneService',
    'SceneEngine',
    'NPCService',
    'SimulationScheduler',
    'WorldKernel',
    'GameMaster',
    'InventorySystem',
  ]

  /** 伪装通道（**永不**放行；它们与"世界住在哪"无关） */
  const FORBIDDEN_TABLES = ['world_events', 'character_intents', 'observations']

  /**
   * 伪装通道的**判据本体**：这些名字必须作为**表**出现才算违规。
   *
   * ============================================================================
   *  ⚠️ 判据修正（2026-10-03，S8/WP2 实测；原判据是 `code.includes(needle)`）
   * ============================================================================
   * 原判据是**子串匹配**，于是任何含 `observations` 的标识符都会被判成"伪装通道"：
   * 实测被误报的是 `storyline_observations`（S8 的世界观测关联表，ADR-093 `D01`）
   * 以及形参名 `observations` —— 它们与"建一张叫 `observations` 的表"是两件事。
   *
   * 判据改成"**表名** + **SQL 关键字上下文**"，并且用 `\b` 词边界：
   * ```text
   *   create table [if not exists] observations     ⇒ 违规
   *   from / into / join / update / alter table observations ⇒ 违规
   *   storyline_observations（下划线相连的复合名）    ⇒ **不**违规（`\b` 不落在 `_` 与 `o` 之间）
   *   形参 observations                            ⇒ **不**违规
   * ```
   * 这条修正**不放宽**任何东西：真正的伪装通道（直接建/查 `observations` 表）照样被拦，
   * 而且下面补了**正控/负控/恢复**三段式自检 —— 原判据没有自检，
   * 所以它既能误报，也无法证明自己真的在测东西（AGENTS.md §6.2/§6.8）。
   */
  const detectForbiddenTableChannels = (code: string): string[] => {
    const hits: string[] = []
    for (const table of FORBIDDEN_TABLES) {
      const pattern = new RegExp(
        `(?:create\\s+table(?:\\s+if\\s+not\\s+exists)?|from|into|join|update|alter\\s+table|delete\\s+from)\\s+${table}\\b`,
        'i'
      )
      if (pattern.test(code)) hits.push(table)
    }
    return hits
  }

  /** 判据自检：正控（真伪装必须响）· 负控（复合名/形参**不许**响）· 恢复 */
  const detectorPositive = detectForbiddenTableChannels(
    'create table if not exists observations (id text primary key)'
  )
  const detectorPositiveSql = detectForbiddenTableChannels('select * from observations where id = 1')
  const detectorNegativeCompound = detectForbiddenTableChannels(
    'create table if not exists storyline_observations (observation_id text primary key)'
  )
  const detectorNegativeParam = detectForbiddenTableChannels(
    'function f(observations: readonly StoryObservationRecord[]) { return observations.length }'
  )
  expect.deepEqual(
    [detectorPositive, detectorPositiveSql, detectorNegativeCompound, detectorNegativeParam],
    [['observations'], ['observations'], [], []],
    '伪装通道判据自检：真表定义/真 SQL 读取必须命中；复合名与形参**不得**命中'
  )

  const detectFileBoundary = (filePath: string, source: string) => {
    const inAllowedDir = ALLOWED_WORLD_DIRS.some((allowed) => filePath.startsWith(allowed))
    const code = stripComments(source)
    const offenders = detectForbiddenTableChannels(code).map((table) => `${table}（伪装通道，永不放行）`)
    for (const symbol of WORLD_SYMBOLS) {
      if (!inAllowedDir && code.includes(symbol)) offenders.push(`${symbol}（世界实现跑到白名单目录之外）`)
    }

    // 解析真实模块引用：类型、注释和路径写法不能被混同为世界存储访问。
    const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
    let storyDependencies = 0
    const check = (specifier: string, registeredImport = false, typeOnly = false) => {
      const target = relative(process.cwd(), resolve(dirname(resolve(filePath)), specifier)).split(sep).join('/')
      if (!/(^|\/)storyline(\/|$)/.test(target)) return
      storyDependencies += 1
      if (inAllowedDir) return
      if (registeredImport && REGISTERED_STORY_IMPORTS[filePath]?.includes(target) &&
          (target !== STORY_TYPES || typeOnly)) return
      offenders.push(`${target}（未登记的故事依赖；类型契约只许 type import）`)
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const typeOnly = clause?.isTypeOnly === true ||
          (clause?.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly))
        check(node.moduleSpecifier.text, clause !== undefined, typeOnly)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined &&
                 ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                 node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
        check(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    return { offenders, storyDependencies }
  }

  // 正控 / 注入 / 恢复：用五份真实源码，逐一证明登记的边都被测到且无目录级豁免。
  let registeredDependencies = 0
  for (const filePath of Object.keys(REGISTERED_STORY_IMPORTS)) {
    const source = readFileSync(join(process.cwd(), filePath), 'utf8')
    const actual = detectFileBoundary(filePath, source)
    expect.greater(actual.storyDependencies, 0, `${filePath} 必须真的包含故事依赖，空集不能 PASS`)
    expect.deepEqual(actual.offenders, [], `${filePath} 的已登记生产依赖必须通过`)
    registeredDependencies += actual.storyDependencies
    const target = relative(dirname(resolve(filePath)), resolve('src/kernel/storyline/world-machine.ts'))
      .split(sep).join('/')
    const injected = `${source}\nimport { advanceFromProposal } from '${target.startsWith('.') ? target : `./${target}`}'\n`
    expect.greater(detectFileBoundary(filePath, injected).offenders.length, 0, `${filePath} 新增未登记世界依赖必须拒绝`)
    expect.deepEqual(detectFileBoundary(filePath, source).offenders, [], `${filePath} 恢复原源码必须重新通过`)
  }
  const rejected = [
    ['src/kernel/policies/probe.ts', "import type { StoryContentPack } from '../storyline/story-types.ts'"],
    ['src/infrastructure/runtime/probe.ts', "import { createStoryLedgerStore } from '../storyline/store/story-ledger-store.ts'"],
    ['src/content/storyline/jichuang-interview-two/story-pack.ts', "import { StoryContentPack } from '../../../kernel/storyline/story-types.ts'"],
    ['src/content/storyline/jichuang-interview-two/render.ts', "import type { StoryLedgerPort } from '../../../kernel/storyline/story-ledger-port.ts'"],
    ['src/infrastructure/runtime/story-cognition.ts', "export { createStoryLedgerStore } from '../storyline/store/story-ledger-store.ts'"],
    ['src/infrastructure/runtime/story-cognition.ts', "const store = import('../storyline/store/story-ledger-store.ts')"],
    ['src/infrastructure/runtime/story-cognition.ts', "import '../storyline/store/story-ledger-store.ts'"],
    ['src/main.ts', "import { createStoryLedgerStore } from './infrastructure/runtime/../storyline/store/story-ledger-store.ts'"],
    ['src/infrastructure/runtime/story-cognition.ts', 'class WorldKernel {}'],
    ['src/content/storyline/jichuang-interview-two/story-pack.ts', 'const sql = `create table observations (id text)`'],
  ]
  for (const [filePath, source] of rejected) {
    expect.greater(detectFileBoundary(filePath, source).offenders.length, 0, `越界反例必须拒绝：${filePath} ${source}`)
  }
  expect.deepEqual(
    detectFileBoundary('src/content/storyline/jichuang-interview-two/story-pack.ts',
      "import { type StoryContentPack } from '../../../kernel/storyline/story-types.ts'").offenders,
    [],
    'inline type import 与 import type 同样是纯类型引用'
  )
  expect.deepEqual(
    detectFileBoundary('src/main.ts', "// import { advanceFromProposal } from './kernel/storyline/world-machine.ts'").offenders,
    [],
    '注释里的 import 说明不构成实际依赖'
  )
  const registeredFiles = Object.keys(REGISTERED_STORY_IMPORTS).length
  console.log(`  [FC-T04 量具] 实际登记依赖=${registeredDependencies} · 注入/恢复=${registeredFiles}/${registeredFiles} · 越界反例=${rejected.length}`)

  const offenders: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      const filePath = relative(process.cwd(), full).split(sep).join('/')
      const reading = detectFileBoundary(filePath, readFileSync(full, 'utf8'))
      offenders.push(...reading.offenders.map((detail) => `${filePath} → ${detail}`))
    }
  }
  walk(join(process.cwd(), 'src'))

  expect.deepEqual(
    offenders,
    [],
    '世界/故事实现只能住在 src/kernel/storyline、src/infrastructure/storyline、' +
      'src/kernel/app/storyline；不得出现 observations / character_intents / world_events **表**；' +
      '白名单之外只允许 ADR-091 §2.1 逐边登记的生产依赖'
  )

  // ⚠️ **量具自检（AGENTS.md §6.8）**：白名单目录必须真的存在，否则上面那条"零违规"
  // 是在"世界还没建"的空集上静默通过的假 PASS。
  const existingAllowed = ALLOWED_WORLD_DIRS.filter((allowed) =>
    existsSync(join(process.cwd(), allowed))
  )
  expect.ok(
    existingAllowed.length >= 1,
    '⚠️ 白名单目录一个都不存在 ⇒ 本判据在空集上假 PASS。' +
      `实测=${JSON.stringify(existingAllowed)}；期望至少 ${ALLOWED_WORLD_DIRS[0]}`
  )

  // ⚠️ **正控**：白名单目录里必须真的有东西被扫到（扫描器本身没坏）。
  let scannedInAllowed = 0
  for (const allowed of existingAllowed) {
    const dir = join(process.cwd(), allowed)
    for (const entry of readdirSync(dir)) if (entry.endsWith('.ts')) scannedInAllowed += 1
  }
  expect.ok(
    scannedInAllowed >= 2,
    `白名单目录里只扫到 ${scannedInAllowed} 个文件 —— 扫描器可能没真的读到世界模块`
  )
})

test('CharacterDomainEvent 不能承担世界事实（scope 校验失败关闭）', () => {
  assertCharacterInternalScope(DOMAIN_EVENT_SCOPE)

  let error: KernelError | undefined
  try {
    assertCharacterInternalScope('WORLD')
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(
    error?.code,
    'domain_event_scope_not_character_internal',
    '世界事实必须走 WorldEvent；塞进角色变化历史会让"她以为"与"世界是"永久混在一起（FC-04）'
  )
})

// ===========================================================================
group('FC-T05 Perspective（计划书第 79 节）')
// ===========================================================================

test('两个角色可以作为不同的 perspectiveOwner 被区分（M9 Belief 的契约前提）', () => {
  type Belief = { perspectiveOwnerId: string; subject: EntityRef; claim: string }

  const sumuweiBelief: Belief = {
    perspectiveOwnerId: String(asEntityId(String(SUMUWEI))),
    subject: entityRef('object', 'loc_box'),
    claim: '箱子里没有钥匙',
  }
  const bBelief: Belief = {
    perspectiveOwnerId: String(asEntityId(String(CHARACTER_B))),
    subject: entityRef('object', 'loc_box'),
    claim: '箱子里有钥匙',
  }

  expect.notOk(
    sumuweiBelief.perspectiveOwnerId === bBelief.perspectiveOwnerId,
    '同一条"世界真相"下，两个人可以持有不同认知 —— 这正是 perspectiveOwnerId 的作用'
  )
  expect.equal(sumuweiBelief.subject.id, bBelief.subject.id, '两个认知指向同一个物体')
  expect.notOk(sumuweiBelief.claim === bBelief.claim, '两人的认知可以相反')
})

test('M9 Belief 合同已落地且边界成立（FC-T05 阶段锁交接，ADR-070 §9）', () => {
  // 旧断言（M3.5：contracts 下无 belief 文件）防的是"无语义权威的半实现"。
  // ADR-070 DESIGN FROZEN 后由**语义边界断言**承接（等强或更强）：
  // 合同存在、事件登记齐、失败关闭、白名单与冻结值逐字可验。
  const registry = createBeliefDomainEventRegistry()
  const registered = registry.types().sort()
  expect.deepEqual(
    registered,
    [...BELIEF_DOMAIN_EVENT_TYPES].sort(),
    '七个 BELIEF_* 事件全部登记（ORIGIN/EVIDENCE_NOTED/FORMED/REINFORCED/DISPUTED/SUPERSEDED/RETRACTED）',
  )

  // INV-M9-01：缺 owner 失败关闭（不是静默跳过）
  let threwOwner = false
  try {
    beliefSlotKeyOf({
      perspectiveOwnerId: '' as unknown as PerspectiveOwnerId,
      subject: entityRef('user', 'user_alex'),
      predicate: 'interaction.explanation_detail',
      scopeKey: 'technical_explanation',
    })
  } catch {
    threwOwner = true
  }
  expect.ok(threwOwner, '槽位键缺 perspectiveOwnerId 必须抛错（INV-M9-01 失败关闭）')

  // D04：EPISODIC 家族不进 B-REPORTED 白名单；非显式权威不合格
  expect.ok(
    !isBeliefReportedEligible({
      type: 'episode',
      authority: 'EXPLICIT_USER_STATEMENT',
      epistemicStatus: 'reported',
      status: 'active',
    }),
    'episode（经历描述）不得形成 B-REPORTED（白名单 = Claim 家族）',
  )
  expect.ok(
    !isBeliefReportedEligible({
      type: 'person_fact',
      authority: 'DIRECT_INTERACTION',
      epistemicStatus: 'reported',
      status: 'active',
    }),
    'DIRECT_INTERACTION 权威的 Memory 不进 B-REPORTED（白名单 = 显式陈述/显式更正）',
  )
  expect.ok(
    isBeliefReportedEligible({
      type: 'preference',
      authority: 'EXPLICIT_CORRECTION',
      epistemicStatus: 'reported',
      status: 'active',
    }),
    '白名单内的合格 Memory 必须通过（正控：全拒绝不是通过）',
  )

  // D05：推断槽位取值闭集逐字冻结
  expect.deepEqual(
    [...BELIEF_INFERRED_VALUES],
    ['detailed', 'concise'],
    'B-INFERRED v1 取值闭集 = detailed | concise（扩值 = 新规则版本）',
  )

  // INV-M9-11：确定性 id + 修订可区分（同输入同 id；不同 formationKey 不同 id）
  const cid = asCharacterId(String(SUMUWEI))
  const slot = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(SUMUWEI)),
    subject: entityRef('user', 'user_alex'),
    predicate: 'interaction.explanation_detail',
    scopeKey: 'technical_explanation',
  })
  expect.equal(
    String(makeBeliefId(cid, slot, '42')),
    String(makeBeliefId(cid, slot, '42')),
    '同一批形成输入必须得到同一 id（幂等）',
  )
  expect.notOk(
    makeBeliefId(cid, slot, '42') === makeBeliefId(cid, slot, '43'),
    '同槽位不同修订必须是不同 id（修订不抹历史）',
  )
})

// ===========================================================================
group('FC-T06 时间（计划书第 80 节）')
// ===========================================================================

test('recordedAt ≠ occurredAt 可以被表达，且事件能正确序列化', () => {
  const recordedAt = 1_760_000_000_000 // 现实 12:00
  const occurredAt = 1_759_900_000_000 // 故事 10:00
  const time = eventTimeOf(recordedAt, occurredAt)
  expect.equal(time.recordedAt, recordedAt)
  expect.equal(time.occurredAt, occurredAt)
  expect.notOk(time.recordedAt === time.occurredAt, '两个时间必须是两个槽位')

  const event = createConversationEvent({
    characterId: SUMUWEI,
    conversationId: CONVERSATION,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    content: '这是很久以前说的。',
    sequence: 1,
    createdAt: recordedAt,
    occurredAt,
  })
  expect.equal(event.createdAt, recordedAt, 'createdAt ≡ recordedAt（既有列不改名）')
  expect.equal(event.occurredAt, occurredAt)
  expect.equal(event.logicalTime, undefined, 'M3.5 不写模拟时间')

  // 序列化往返（落库那一条由 m3.5:verify 在沙箱库上跑）
  const roundTripped = JSON.parse(JSON.stringify(event)) as typeof event
  expect.equal(roundTripped.occurredAt, occurredAt)
  expect.equal(roundTripped.createdAt, recordedAt)
})

test('不传 occurredAt 时它就是 undefined —— "不知道"不等于"就是现在"', () => {
  const event = userEventFor()
  expect.equal(
    event.occurredAt,
    undefined,
    '用 createdAt 冒充 occurredAt 会让未来的导入逻辑无法分辨哪些行需要补时间'
  )
})

test('模拟时间的位置已留好，但 M3.5 拒绝写入（不要建半个时钟）', () => {
  expect.notOk(M3_5_ALLOWS_LOGICAL_TIME, 'M3.5 明确不建模拟时钟（计划书第 32 节）')

  let error: KernelError | undefined
  try {
    assertEventTime({ recordedAt: 1, logicalTime: '第 12 天清晨' })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(
    error?.code,
    'simulation_time_not_supported',
    '有人写了 logicalTime 却没人按它排序，比没有更危险'
  )
})

test('非法时间戳被拒绝（NaN 会静默地把事件顺序弄坏）', () => {
  let error: KernelError | undefined
  try {
    assertEventTime({ recordedAt: Number.NaN })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'bad_recorded_at')

  let occurredError: KernelError | undefined
  try {
    assertEventTime({ recordedAt: 1, occurredAt: Number.POSITIVE_INFINITY })
  } catch (e) {
    occurredError = e as KernelError
  }
  expect.equal(occurredError?.code, 'bad_occurred_at')
})

// ===========================================================================
group('FC-T07 Trigger（计划书第 81 节）')
// ===========================================================================

test('Job Contract 不依赖 Conversation Event（triggerKind=system 可以没有对话来源）', () => {
  const systemJob = {
    triggerKind: 'system' as TriggerKind,
    sourceFromSequence: 0,
    sourceToSequence: 0,
  }
  const trigger = triggerOf(systemJob)
  expect.equal(trigger.kind, 'system')
  expect.equal(trigger.sourceRefs.length, 1, '触发描述给出的是序号区间引用，不编造事件 id')
  expect.equal(trigger.sourceRefs[0], 'sequence:0..0')
})

test('缺省触发是 conversation（旧行的真实含义，不是猜测）', () => {
  expect.equal(triggerKindOf({}), 'conversation')
  expect.equal(triggerKindOf({ triggerKind: undefined }), 'conversation')
  expect.deepEqual([...M3_5_ENABLED_TRIGGER_KINDS], ['conversation', 'system'])
})

test('预留的触发种类已登记但不启用（现在没有调度器能产出它们）', () => {
  expect.deepEqual(
    [...M3_5_RESERVED_TRIGGER_KINDS].sort(),
    ['environment', 'external_event', 'schedule'],
    '计划书第 36 节列的三种必须已经在枚举里'
  )
  for (const kind of M3_5_RESERVED_TRIGGER_KINDS) {
    let error: KernelError | undefined
    try {
      assertTriggerEnabledInM3_5(kind)
    } catch (e) {
      error = e as KernelError
    }
    expect.equal(error?.code, 'trigger_kind_not_enabled', `${kind} 在 M3.5 必须拒绝`)
  }
  assertTriggerEnabledInM3_5('conversation')
  assertTriggerEnabledInM3_5('system')
})

// ===========================================================================
group('FC-T08 当前回归（计划书第 82 节）')
// ===========================================================================

test('Prompt 与 M3 逐字节一致（Observation/Intent 改造不得影响她看到的东西）', async () => {
  const result = await buildBaselinePrompt()

  const promptPath = join(process.cwd(), BASELINE_FIXTURE_DIR, BASELINE_PROMPT_FILE)
  const metaPath = join(process.cwd(), BASELINE_FIXTURE_DIR, BASELINE_META_FILE)
  const expectedPrompt = readFileSync(promptPath, 'utf8')
  const expectedMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
    compilerVersion: string
    contextSectionIds: string[]
    seedVersion: number
    seedHash: string
  }

  /*
   * ⚠️ 比对前把两边的行尾归一成 LF。
   *
   * 这不是放松判据，而是消除一个**与她的 prompt 无关**的变量：
   * 行尾是版本控制的产物（本机 `core.autocrlf=true` 会把工作区的
   * LF 检出成 CRLF），而"她看到的 prompt"里用的是 `\n`。
   *
   * 这个坑是实测踩到的：`.gitattributes` 给夹具钉了 LF，
   * 但那条只覆盖 git 的检出路径 —— 编辑器保存、zip 解压、跨平台拷贝
   * 都不会经过它。两道保险都在，守卫才不会因为一次 checkout 而误报。
   *
   * 归一化只影响 `\r`：正文内容、section 顺序、措辞的任何变化仍然会被抓到。
   */
  const toLf = (text: string): string => text.replace(/\r\n/g, '\n')

  expect.equal(
    toLf(result.prompt),
    toLf(expectedPrompt),
    'M3.5 只该改"输入/输出边界"，一个字都不该改 prompt。若这里失败，先看是不是顺手改了 prompt 结构'
  )
  expect.equal(result.meta.compilerVersion, expectedMeta.compilerVersion)
  expect.deepEqual(result.meta.contextSectionIds, expectedMeta.contextSectionIds)
  expect.equal(result.meta.seedVersion, expectedMeta.seedVersion, 'Seed 版本不得因为 M3.5 而变化')
  expect.equal(result.meta.seedHash, expectedMeta.seedHash, 'Seed 指纹不得因为 M3.5 而变化')
})

test('显式输入与 Observation 派生结果不一致 → 失败关闭（不许两个来源并存）', () => {
  const observation = conversationObservationFrom(userEventFor(SUMUWEI, '你还记得我们第一次见面吗？'))

  // 一致：通过，并且文本以派生结果为准
  const ok = characterTurnContextOf({
    characterId: SUMUWEI,
    observation,
    currentInput: '你还记得我们第一次见面吗？',
  })
  expect.equal(ok.currentInput, '你还记得我们第一次见面吗？')

  // 不一致：抛错，而不是"取其中一个为准"
  let error: KernelError | undefined
  try {
    characterTurnContextOf({
      characterId: SUMUWEI,
      observation,
      currentInput: '一句完全不同的话',
    })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(
    error?.code,
    'observation_input_mismatch',
    '两个来源必然有一天会分叉；分叉的那一刻必须被看见'
  )
})

test('合成轮次（没有 Observation）仍可用 currentInput 编译 —— 与 M3 一致', () => {
  const context = characterTurnContextOf({
    characterId: SUMUWEI,
    currentInput: '合成轮次输入',
  })
  expect.equal(context.observation, undefined)
  expect.equal(context.currentInput, '合成轮次输入')

  let error: KernelError | undefined
  try {
    characterTurnContextOf({ characterId: SUMUWEI })
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'turn_without_input', '没有任何输入就不该编译')
})

test('SpeechIntent id 是 intent 自己的身份，与事件 id 不同（引用而非复制）', () => {
  const intent = createSpeechIntent({ characterId: SUMUWEI, text: 'a' })
  const resolution = intentResolutionOf(intent.id, 'accepted', { resultRefs: ['cev:x:y:1'] })
  expect.equal(String(resolution.intentId), String(intent.id))
  expect.notOk(
    String(resolution.intentId) === resolution.resultRefs?.[0],
    'Intent 与 Result 是两件事（FC-03）：一个是"她想做"，一个是"变成了什么"'
  )
  expect.ok(asIntentId('int:test-1') !== undefined)
  expect.ok(asObservationId('obs:test-1') !== undefined)
})

// ---------------------------------------------------------------------------
const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M3.5 Future Compatibility 测试')
process.exit(summary.failed === 0 ? 0 : 1)
