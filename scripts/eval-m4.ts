/**
 * M4 场景套件 —— 计划书第 173 节列出的 M4-001 ~ M4-018。
 *
 * ============================================================================
 *  与 `m4:verify` 的分工（避免两处各测一半、又都以为对方测了）
 * ============================================================================
 * 计划书第 113 节说内部 Scenario 才是 canonical test definition。
 * 但 M4 的场景里有一部分**天然是持久化链路的验证**（记住 → 落库 → 查回），
 * 它们在 `verify-m4-persistence.ts` 里已经有了更细的断言。
 * 因此本文件的策略是：
 *
 *   · **不重复**已在那里覆盖的场景，而是在输出的映射表里**明确指向**它
 *   · 这里实现的是**行为语义**场景：抽取的取舍、污染的拒绝、
 *     槽位与限定条件、版本与来源隔离
 *
 * 那张映射表是刻意打印的：一张"哪些场景在哪测"的清单，
 * 比两份各自声称"全覆盖"的脚本可靠 —— 后者最容易出现
 * "两边都以为对方测了那个"（M3.5 审计那条老教训的变体）。
 *
 * 跑法：pnpm eval:m4
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import 之前
import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'


import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { findEventRefs } from '../src/infrastructure/persistence/conversation-store.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import {
  applyMemoryEvent,
  createNativeMemoryStore,
} from '../src/infrastructure/persistence/memory-store.ts'
import { createMemoryMutationValidator } from '../src/kernel/policies/memory-validator.ts'
import { runMemoryExtractionPipeline } from '../src/kernel/app/memory/pipeline.ts'
import {
  LlmMemoryExtractor,
  RuleBasedMemoryExtractor,
  processorEventViewOf,
  resolveCandidates,
} from '../src/kernel/app/memory/extractor.ts'
import {
  asConversationId,
  createFullDomainEventRegistry,
  createMemoryCandidate,
  entityRef,
  slotOfCandidate,
  slotOfRecord,
  type ConversationEvent,
  type MemoryCandidate,
} from '../src/kernel/contracts/index.ts'
import { applyValueGate } from '../src/kernel/app/memory/value.ts'
import { analyzeConflict, resolveConflict } from '../src/kernel/app/memory/conflict.ts'

// ---------------------------------------------------------------------------
// 检查器
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function scenario(id: string, title: string): void {
  console.log(`\n=== ${id} ${title} ===`)
}

// ---------------------------------------------------------------------------
// 沙箱
// ---------------------------------------------------------------------------

await resetPluginSqlConnection()
const sandbox = isolateDatabase('m4-scenarios', { keep: true })
const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })

await initDatabase(runtime)
await runtime.initialize()
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
  registry: createFullDomainEventRegistry(),
})

const db = getRawDb(runtime)
const owner = entityRef('character', characterId)
const user = entityRef('user', userId)
const store = createNativeMemoryStore(db)

const validator = createMemoryMutationValidator({
  registry: kernel.registry,
  sources: { findEvents: (ids) => findEventRefs(db, ids as never) },
  processed: {
    hasProcessed: async (key) => {
      const rows = await db.execute(
        sql`select 1 as one from processed_operations where idempotency_key = ${key} limit 1`
      )
      return rowsOf(rows).length > 0
    },
  },
  lookup: {
    findActiveByFingerprint: async ({ owner: o, fingerprint }) => {
      const found = await store.getActiveByFingerprint(o, fingerprint)
      return found === null ? undefined : { memoryId: found.id }
    },
    findActiveByCanonicalKey: async ({ owner: o, canonicalKey }) =>
      (await store.getActiveByCanonicalKey(canonicalKey))
        .filter((r) => String(r.owner.id) === String(o.id))
        .map((r) => ({ memoryId: r.id })),
    getRecord: async (id) => (await store.get(id)) ?? undefined,
  },
})

const recorder = new ConversationRecorder({
  db,
  characterId: kernel.characterId,
  conversationId: asConversationId(`dm-${characterId}-m4scenarios`),
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'eval-m4',
  /*
   * M5.1.1 / Phase 4a（ADR-043 `DR-6`）：与 `src/main.ts:532` 同一行。
   * 本评测的 `userSays` 代表"用户本人直接说"（交互式人类控制台），`sheSays`
   * 走角色的输出边界 —— 两条通道都要装，否则事件行落成 legacy，
   * 事实类候选会被来源资格闸失败关闭地拒掉（而那不是本评测要测的东西）。
   */
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
})

let conversationSequence = 0

/** 写一条用户事件，返回它（以及"她该回的序号"） */
async function userSays(
  text: string
): Promise<{ event: ConversationEvent; assistantSequence: number }> {
  conversationSequence += 1
  const { event, assistantSequence } = await recorder.recordUserMessage(text, conversationSequence)
  if (event === undefined || assistantSequence === undefined) {
    throw new Error('写入用户事件失败')
  }
  return { event, assistantSequence }
}

/** 写一条她的事件 */
async function sheSays(
  text: string,
  characterSequence: number,
  replyTo?: string
): Promise<ConversationEvent> {
  conversationSequence += 1
  const event = await recorder.recordAssistantMessage({
    text,
    conversationSequence,
    characterSequence,
    ...(replyTo ? { replyToEventId: replyTo as never } : {}),
  })
  if (event === undefined) throw new Error('写入助手事件失败')
  return event
}

/** 用**固定候选**跑一次抽取流水线（场景只关心语义，不关心抽取规则表） */
async function runWith(
  candidates: MemoryCandidate[],
  events: readonly ConversationEvent[],
  options: { utterance?: string; threshold?: number } = {}
) {
  return runMemoryExtractionPipeline(
    {
      extractor: {
        name: 'scenario-extractor',
        version: 'scenario-extractor@1',
        async process(input) {
          // 把调用方给的候选原样返回（它们已经是 MemoryCandidate）
          void input
          return { candidates, rejected: [], extracted: candidates.length > 0 }
        },
      },
      validator,
      commit: async (accepted, now) =>
        (await applyAcceptedEvents(db, kernel.characterId, accepted, [], now)).domainEvents,
      fold: (event) => applyMemoryEvent(db, event),
      valueOptions: {
        explicit: false,
        ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      },
      ...(options.utterance !== undefined ? { utterance: options.utterance } : {}),
      conflict: {
        recordsInCanonicalSlot: async ({ canonicalKey }) => {
          const active = await store.getActiveByCanonicalKey(canonicalKey)
          const disputed = (
            await store.list({ owner, status: 'disputed', limit: 500 })
          ).filter((r) => r.canonicalKey === canonicalKey)
          return [...active, ...disputed]
        },
      },
    },
    {
      owner,
      events,
      speaker: user,
      processorContext: {
        processorName: 'scenario-extractor',
        processorVersion: 'scenario-extractor@1',
      },
    }
  )
}

/** 从前一批事件造候选（走真实契约断言） */
function candidate(
  type: 'person_fact' | 'preference' | 'episode' | 'self_experience',
  content: never,
  evidence: readonly ConversationEvent[],
  authority: 'EXPLICIT_USER_STATEMENT' | 'DIRECT_INTERACTION' | 'CHARACTER_GENERATION',
  subjects: never[]
): MemoryCandidate {
  return createMemoryCandidate({
    owner,
    type,
    content,
    subjects,
    sourceRefs: evidence.map((e) => ({ kind: 'conversation_event' as const, id: String(e.id) })),
    evidenceRootIds: evidence.map((e) => String(e.id)),
    epistemicStatus: type === 'episode' || type === 'self_experience' ? 'observed' : 'reported',
    authority,
    importance: 0.5,
    confidence: 0.9,
    processor: 'scenario-extractor',
    processorVersion: 'scenario-extractor@1',
  })
}

// ===========================================================================
// M4-008 Low-value Rejection（计划书第 180 节）
// ===========================================================================

scenario('M4-008', 'Low-value Rejection —— "哈哈 / 嗯 / 好的" 产生 0 条长期记忆')

{
  const t1 = await userSays('哈哈')
  const t2 = await userSays('嗯')
  const t3 = await userSays('好的')
  const events = [t1.event, t2.event, t3.event]

  // 低价值：一个未登记的一次性槽位（"今天的心情"）
  const lowValue = candidate(
    'person_fact',
    { kind: 'claim', subject: user, predicate: 'mood.today', value: 'ok' } as never,
    [t1.event],
    'EXPLICIT_USER_STATEMENT',
    [user] as never
  )

  const run = await runWith([lowValue], events)
  check(
    '低价值候选被值闸拒绝（计划书第 53 / 180 节：REJECT 是正常结果）',
    run.created.length === 0 && run.valueRejected >= 1,
    `created=${run.created.length} valueRejected=${run.valueRejected}`
  )
  check(
    '拒绝**不是**故障（没有抛错，pipeline 正常返回）',
    run.rejections.some((r) => r.reason === 'low_value'),
    run.rejections.map((r) => r.reason).join(',')
  )
}

// ===========================================================================
// M4-009 Assistant Guess（计划书第 181 节 / 第 148 节 Critical Test）
// ===========================================================================

scenario('M4-009', 'Assistant Guess —— "我猜你喜欢猫" 产生 0 条 Preference')

{
  const t = await userSays('猜猜我喜欢什么')
  const guess = await sheSays('我猜你喜欢猫', t.assistantSequence, String(t.event.id))

  // 直接构造一条"用她的话当证据的偏好" —— 放行口必须拒它
  let threw = false
  let code = ''
  try {
    createMemoryCandidate({
      owner,
      type: 'preference',
      content: { kind: 'claim', subject: user, predicate: 'pet.preference.cat', value: 'like' },
      subjects: [user],
      sourceRefs: [{ kind: 'conversation_event', id: String(guess.id) }],
      evidenceRootIds: [String(guess.id)],
      epistemicStatus: 'generated',
      authority: 'CHARACTER_GENERATION', // ← 她自己猜的
      importance: 0.5,
      confidence: 0.9,
      processor: 'scenario-extractor',
      processorVersion: 'scenario-extractor@1',
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  check(
    '她的猜测**建不了**用户 Preference（计划书第 148 / 181 节，M4 Critical Test）',
    threw && code.includes('authority_cannot_establish_person_fact'),
    code || '(没有抛错 —— 污染路径被允许了)'
  )

  // 而抽取器的 Source Firewall 也不采信她的话
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'preference',
        subjectToken: 'USER',
        claim: { predicate: 'pet.preference.cat', value: 'like' },
        evidenceEventSequences: [guess.sequence],
      },
    ],
    {
      owner,
      events: [processorEventViewOf(guess)],
      speaker: user,
      processor: 'scenario-extractor',
      processorVersion: 'scenario-extractor@1',
    }
  )
  check(
    'Source Firewall 也拦住它（两道闸，而不是一道）',
    resolved.length === 1 && !resolved[0].ok,
    resolved[0]?.ok === false ? resolved[0].rejection.reason : '被接受了'
  )
}

// ===========================================================================
// M4-010 Self-fabrication（计划书第 182 节 / 第 149 节）
// ===========================================================================

scenario('M4-010', 'Self-fabrication —— "我小时候养过猫" 产生 0 条历史 SelfExperience')

{
  const t = await userSays('你小时候养过什么吗')
  const fabricated = await sheSays('我小时候养过猫', t.assistantSequence, String(t.event.id))

  const resolved = resolveCandidates(
    [
      {
        memoryType: 'self_experience',
        subjectToken: 'CHARACTER',
        episode: {
          summary: '苏沐薇小时候养过一只猫',
          participantTokens: ['CHARACTER'],
        },
        evidenceEventSequences: [fabricated.sequence],
      },
    ],
    {
      owner,
      events: [processorEventViewOf(fabricated)],
      speaker: user,
      processor: 'scenario-extractor',
      processorVersion: 'scenario-extractor@1',
    }
  )
  check(
    '她临时编的"小时候"**建不了** SELF_EXPERIENCE（计划书第 149 / 182 节）',
    resolved.length === 1 && !resolved[0].ok,
    resolved[0]?.ok === false ? resolved[0].rejection.reason : '被接受了'
  )
}

// ===========================================================================
// M4-011 Real Shared Episode（计划书第 183 节 / 第 150 节）
// ===========================================================================

scenario('M4-011', 'Real Shared Episode —— 真实的共同经历**可以**成为 EPISODE')

{
  const t = await userSays('我们一起把这个记忆架构的问题解决了吧')
  const hers = await sheSays('好，先从证据链开始', t.assistantSequence, String(t.event.id))

  const episodeCandidate = candidate(
    'episode',
    {
      kind: 'episode',
      summary: '苏沐薇和 Alex 一起梳理了长期记忆的证据链问题',
      participants: [owner, user],
      eventRefs: [String(t.event.id), String(hers.id)],
      topicTags: ['memory', 'architecture'],
    } as never,
    [t.event, hers],
    'DIRECT_INTERACTION',
    [owner, user] as never
  )

  const run = await runWith([episodeCandidate], [t.event, hers], { threshold: 0 })
  check(
    '真实发生过的共同经历被记为 EPISODE（**不是**一律拒 —— 那是过度修正）',
    run.created.length === 1,
    `created=${run.created.length} rejected=${run.rejections.map((r) => r.reason).join(',')}`
  )
  if (run.created.length === 1) {
    check(
      'Episode 有两个参与者（计划书第 8 节的例子）',
      run.created[0].subjects.length === 2,
      run.created[0].subjects.map((s) => s.kind).join('+')
    )
    check(
      'Episode 带完整 event refs（能追回它由哪些事件组成）',
      run.created[0].content.kind === 'episode' &&
        run.created[0].content.eventRefs.length === 2,
      run.created[0].content.kind === 'episode'
        ? `${run.created[0].content.eventRefs.length} 条`
        : ''
    )
  }
}

// ===========================================================================
// M4-012 Contextual Preference（计划书第 152 节）
// ===========================================================================

scenario('M4-012', 'Contextual Preference —— 限定条件不同 = **两个槽位**，不许合并')

{
  const t = await userSays('技术问题我喜欢详细解释，普通闲聊简单点就行')
  const events = [t.event]

  const technical = candidate(
    'preference',
    {
      kind: 'claim',
      subject: user,
      predicate: 'preferred.explanation.style',
      value: 'detailed',
      qualifiers: { context: 'technical' },
    } as never,
    events,
    'EXPLICIT_USER_STATEMENT',
    [user] as never
  )
  const casual = candidate(
    'preference',
    {
      kind: 'claim',
      subject: user,
      predicate: 'preferred.explanation.style',
      value: 'brief',
      qualifiers: { context: 'casual' },
    } as never,
    events,
    'EXPLICIT_USER_STATEMENT',
    [user] as never
  )

  const slotA = slotOfCandidate(technical)
  const slotB = slotOfCandidate(casual)
  check(
    '两个限定的槽位键**不同**（不许被合并成"用户喜欢详细"）',
    slotA !== undefined && slotB !== undefined && slotA.canonicalKey !== slotB.canonicalKey,
    `${slotA?.canonicalKey} vs ${slotB?.canonicalKey}`
  )

  const run = await runWith([technical, casual], events, { threshold: 0 })
  check(
    '两条限定偏好都进库（不是互相取代）',
    run.created.length === 2,
    `created=${run.created.length} rejected=${run.rejections.map((r) => r.reason).join(',')}`
  )
  check(
    '它们都还是 ACTIVE（同一 predicate 的两个不同限定**并存**是对的）',
    run.created.every((r) => r.status === 'active'),
    run.created.map((r) => r.status).join(',')
  )
}

// ===========================================================================
// M4-016 Processor Version Change（计划书第 186 节 / 第 66–67 节）
// ===========================================================================

scenario('M4-016', 'Processor Version Change —— @2 不被 @1 的幂等记录拦住')

{
  const { memoryExtractionIdempotencyKey } = await import('../src/kernel/app/memory/job.ts')
  const v1 = memoryExtractionIdempotencyKey({
    characterId: kernel.characterId,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    fromSequence: 1,
    toSequence: 1,
  })
  const v2 = memoryExtractionIdempotencyKey({
    characterId: kernel.characterId,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@2',
    fromSequence: 1,
    toSequence: 1,
  })
  check('同一区间、不同版本 → 不同幂等键', v1 !== v2, `${v1.slice(0, 12)} vs ${v2.slice(0, 12)}`)

  // 记录里的 processorVersion 让"找出所有 @1 的产物"可执行
  const t = await userSays('记住，我平时用 VS Code')
  const run = await runWith(
    [
      candidate(
        'preference',
        {
          kind: 'claim',
          subject: user,
          predicate: 'tooling.preference.editor',
          value: 'VS Code',
        } as never,
        [t.event],
        'EXPLICIT_USER_STATEMENT',
        [user] as never
      ),
    ],
    [t.event],
    { threshold: 0 }
  )
  check(
    '记忆带 processorVersion（能按版本审计 / 重处理 / 撤回）',
    run.created.length === 1 && run.created[0].processorVersion === 'scenario-extractor@1',
    String(run.created[0]?.processorVersion)
  )
}

// ===========================================================================
// M4-017 Evidence Missing（计划书第 126 节）
// ===========================================================================

scenario('M4-017', 'Evidence Missing —— 引用不存在的证据 → 拒绝整条候选')

{
  const t = await userSays('我不吃香菜')
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'preference',
        subjectToken: 'USER',
        claim: { predicate: 'food.preference.cilantro', value: 'dislike' },
        // 999 不在本批次里
        evidenceEventSequences: [t.event.sequence, 999],
      },
    ],
    {
      owner,
      events: [processorEventViewOf(t.event)],
      speaker: user,
      processor: 'scenario-extractor',
      processorVersion: 'scenario-extractor@1',
    }
  )
  check(
    '引用不存在的证据序号 → **拒绝**（不就近取、不忽略）',
    resolved.length === 1 &&
      !resolved[0].ok &&
      resolved[0].rejection.reason === 'evidence_sequence_not_in_batch',
    resolved[0]?.ok === false ? resolved[0].rejection.reason : '被接受了'
  )
}

// ===========================================================================
// M4-018 Tool Source Isolation（计划书第 154 节）
// ===========================================================================

scenario('M4-018', 'Tool Source Isolation —— 工具输出不能被当成用户陈述')

{
  // 直接造一条 tool 事件（走真实构造器，因此 actorType=type 的一致性会被校验）
  const { createConversationEvent } = await import('../src/kernel/contracts/index.ts')
  const toolEvent = createConversationEvent({
    characterId: kernel.characterId,
    conversationId: asConversationId(`dm-${characterId}-m4scenarios`),
    conversationSequence: 900,
    sequence: 900,
    type: 'tool_event',
    actorType: 'tool',
    actorId: 'weather-service',
    content: '{"temperatureC":20}',
  })

  let threw = false
  let code = ''
  try {
    processorEventViewOf(toolEvent)
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  check(
    'tool 事件被抽取器**拒绝**（不许靠冒充 character/system 混进来）',
    threw && code.includes('tool_event_not_extractable_in_m4'),
    code || '(没有抛错)'
  )

  // 也不许把它标成 user_report
  check(
    '工具来源的认知标签是 tool_observation（不是 user_report）',
    toolEvent.epistemicSource === 'tool_observation',
    toolEvent.epistemicSource
  )
  check(
    '工具来源的权威是 TOOL_OBSERVATION（不是 USER_EXPLICIT）',
    toolEvent.sourceAuthority === 'TOOL_OBSERVATION',
    toolEvent.sourceAuthority
  )
}

// ===========================================================================
// 覆盖映射（计划书第 173 节的 18 个场景）
// ===========================================================================

console.log(`\n${'='.repeat(72)}`)
console.log('M4 场景覆盖映射（计划书第 173 节）')
console.log('='.repeat(72))
const coverage: [string, string][] = [
  ['M4-001 Explicit Remember', 'verify-m4-persistence.ts §13'],
  ['M4-002 Explicit Correction', 'verify-m4-persistence.ts §13'],
  ['M4-003 Explicit Forget', 'verify-m4-persistence.ts §13'],
  ['M4-004 Duplicate Fact', 'verify-m4-persistence.ts §13 + kernel-tests-memory.ts 去重'],
  ['M4-005 Temporal Change', 'verify-m4-persistence.ts §16'],
  ['M4-006 Contradictory Fact', 'verify-m4-persistence.ts §16'],
  ['M4-007 Ambiguous Conflict', 'verify-m4-persistence.ts §13（target_ambiguous）'],
  ['M4-008 Low-value Rejection', '**本套件**'],
  ['M4-009 Assistant Guess', '**本套件**'],
  ['M4-010 Self-fabrication', '**本套件**'],
  ['M4-011 Real Shared Episode', '**本套件**'],
  ['M4-012 Contextual Preference', '**本套件**'],
  ['M4-013 Cross-session Persistence', 'verify-m4-persistence.ts §9（同进程内的两次查询）'],
  ['M4-014 Restart Persistence', '**Phase 12**（需要跨进程，尚未实现）'],
  ['M4-015 Duplicate Worker', 'verify-m4-persistence.ts §15'],
  ['M4-016 Processor Version Change', '**本套件** + kernel-tests-memory.ts 幂等键'],
  ['M4-017 Evidence Missing', '**本套件**'],
  ['M4-018 Tool Source Isolation', '**本套件**'],
]
for (const [id, where] of coverage) console.log(`  ${id.padEnd(36, ' ')} ${where}`)

await runtime.stop().catch(() => undefined)
cleanupSandbox(sandbox.dir)

console.log(`\n${'='.repeat(72)}`)
console.log(`M4 场景套件：${passed} 通过 / ${failed} 失败`)
console.log(`实验库：${sandbox.dir}（已清理，真实库未被触碰）`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(72))

process.exit(failed === 0 ? 0 : 1)
