/**
 * M4 领域模型测试（WP1 Gate，计划书第 115–116 / 171 节）。
 *
 * ============================================================================
 *  这个文件只测**契约**，不碰数据库、不调模型
 * ============================================================================
 * 与 `kernel-tests.ts` 同一个定位：deterministic、离线、秒级。
 * 因此它是"每次改契约都能跑"的那一层。
 *
 * 覆盖的是计划书第 171 节列出的**单元**项里属于领域模型的部分：
 *   CanonicalMemoryKey / Authority ordering / Evidence validation /
 *   Memory type & content 匹配 / 反污染三条 / 派生证据继承 /
 *   Content fingerprint / 稳定序列化 / 幂等 id 派生 / predicate 登记表
 *
 * WP2 的事件 / reducer / replay 在 `verify-m4-persistence.ts`（需要数据库）。
 *
 * 跑法：npx tsx scripts/kernel-tests-memory.ts [过滤器]
 */

import { readFileSync } from 'node:fs'
import ts from 'typescript'

import {
  // 契约
  MEMORY_AUTHORITIES,
  MEMORY_DOMAIN_EVENT_TYPES,
  MEMORY_EPISTEMIC_STATUSES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MEMORY_CREATED,
  MEMORY_DISPUTED,
  MEMORY_MERGED,
  MEMORY_RESTORED,
  MEMORY_RETRACTED,
  MEMORY_SUPERSEDED,
  REGISTERED_DOMAIN_EVENT_TYPES,
  assertContentMatchesType,
  assertMemoryAuthorityAllows,
  assertMemoryEvidence,
  authorityFromSource,
  authorityRank,
  canonicalKeyOf,
  canEstablishUserFact,
  compareAuthority,
  contentFingerprintOf,
  createDefaultDomainEventRegistry,
  createFullDomainEventRegistry,
  createMemoryCandidate,
  createMemoryDomainEventRegistry,
  entityRef,
  isClaimMemoryType,
  isEpisodicMemoryType,
  isRecallEligible,
  isRegisteredPredicate,
  makeMemoryId,
  memoryDigest,
  memorySlotFor,
  normalizePredicate,
  ownerCharacterId,
  recordFromCandidate,
  registeredPredicates,
  registerPredicateForTest,
  stableMaterial,
  validateClaimContent,
  validateEpisodicContent,
  valueFitsShape,
  type ClaimMemoryContent,
  type EpisodicMemoryContent,
  type EvidenceRef,
  type MemoryCandidate,
  type MemoryContent,
  type MemoryRecord,
  type MemoryType,
  type NewMemoryCandidate,
} from '../src/kernel/contracts/index.ts'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'
import {
  createMemoryReducer,
  MEMORY_HANDLED_EVENT_TYPES,
} from '../src/kernel/projections/memory.ts'
import { MEMORY_REDUCER_VERSION } from '../src/kernel/contracts/index.ts'
import {
  asCharacterId,
  asConversationId,
  createConversationEvent,
} from '../src/kernel/contracts/index.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  MEMORY_INTENT_RULES,
  LlmMemoryIntentClassifier,
  RuleOnlyMemoryIntentClassifier,
  detectByRule,
  detectExplicitIntentFromEvent,
  createExplicitMemoryIntentDetector,
} from '../src/kernel/app/memory/intent-detector.ts'
import {
  ChainedContentExtractor,
  RuleBasedContentExtractor,
} from '../src/kernel/app/memory/content-extractor.ts'
import {
  applyResponseTruthPolicy,
  replyClaimsSuccess,
  RESPONSE_SUCCESS_MARKERS,
} from '../src/kernel/app/memory/response-truth.ts'
/* ★ A2（2026-10-10）：判据是纯函数 ⇒ 门可以直接量到它 */
import { asksToRemember } from '../src/kernel/app/memory/remember-request.ts'
import type { ExplicitMemoryTurnResult } from '../src/kernel/app/memory/explicit-turn.ts'
import {
  LexicalSemanticJudge,
  LlmSemanticJudge,
  createTargetMemoryResolver,
  lexicalFragments,
  lexicalOverlapHits,
  mayMutate,
  parseChoiceIndex,
  scoreByHints,
  type SemanticJudgePort,
} from '../src/kernel/app/memory/target-resolver.ts'
import {
  LlmMemoryExtractor,
  RuleBasedMemoryExtractor,
  buildExtractionPrompt,
  parseCandidatesJson,
  processorEventViewOf,
  resolveCandidates,
} from '../src/kernel/app/memory/extractor.ts'
import {
  applyValueGate,
  evaluateValue,
  isTimeScopedPredicate,
} from '../src/kernel/app/memory/value.ts'
import {
  canRetryMemoryJob,
  contiguousFrontierFrom,
  memoryExtractionIdempotencyKey,
} from '../src/kernel/app/memory/job.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { CONTENT_RULE_VERSION } from '../src/kernel/app/memory/content-extractor.ts'
import {
  CORRECTION_FALLBACK_VERSION,
  extractCorrectionValue,
  slotRestrictedCorrectionValue,
  pickRecentExplicitWriteTarget,
} from '../src/kernel/app/memory/correction-fallback.ts'
import { describeKernelFlags, readKernelFlags } from '../src/kernel/app/flags.ts'
import { describeReadOnlyInvocation, isReadOnlyInvocation } from '../src/invocation.ts'
import {
  analyzeConflict,
  evidenceExcludingCharacterGuess,
  findTemporalChangeMarker,
  resolveConflict,
  slotOfRecord,
} from '../src/kernel/app/memory/conflict.ts'
import { slotOfCandidate } from '../src/kernel/contracts/index.ts'
import {
  assertDerivedEvidenceInherits,
  buildSlotTimeline,
  describeProvenance,
  describeValidity,
  inheritedEvidenceRoots,
  renderMemoryHistory,
} from '../src/kernel/app/memory/provenance.ts'
import {
  assertNoMemoryContentInTrace,
  declaredMemoryStepKinds,
  declaredMemoryTraceAttributeKeys,
  explicitIntentStep,
  memoryPipelineSteps,
  memoryTraceAttributes,
  sensitiveTextsOf,
} from '../src/kernel/app/memory/memory-trace.ts'
import {
  memoryAdminUsage,
  parseMemoryAdminArgs,
  renderMemoryAudit,
  renderMemoryDetail,
  renderMemoryList,
  renderMemorySources,
  renderMemoryStats,
} from '../src/kernel/app/memory/admin.ts'

// ---------------------------------------------------------------------------
// 固定夹具（**不用随机、不用当前时间**：契约测试必须每次得到同一结果）
// ---------------------------------------------------------------------------

const CHARACTER = entityRef('character', 'char_sumuwei')
const USER = entityRef('user', 'user_alex')
const OTHER_USER = entityRef('user', 'user_sample_b')

const T0 = 1_700_000_000_000

const evidence = (n: number): EvidenceRef => ({
  kind: 'conversation_event',
  id: `cev:char_sumuwei:conv1:${n}`,
})

function claim(overrides: Partial<ClaimMemoryContent> = {}): ClaimMemoryContent {
  return {
    kind: 'claim',
    subject: USER,
    predicate: 'food.preference.cilantro',
    value: 'dislike',
    ...overrides,
  }
}

function episode(overrides: Partial<EpisodicMemoryContent> = {}): EpisodicMemoryContent {
  return {
    kind: 'episode',
    summary: '他们一起讨论了角色 Agent 的长期记忆架构',
    participants: [CHARACTER, USER],
    eventRefs: [evidence(1).id, evidence(2).id],
    ...overrides,
  }
}

function candidate(
  type: MemoryType,
  content: MemoryContent,
  overrides: Partial<NewMemoryCandidate> = {}
): MemoryCandidate {
  return createMemoryCandidate({
    owner: CHARACTER,
    type,
    content,
    subjects: content.kind === 'claim' ? [content.subject] : content.participants,
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.8,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    ...overrides,
  })
}

/** 由候选造出正式记录（只走 reducer 会走的那条路） */
function record(
  type: MemoryType,
  content: MemoryContent,
  overrides: Partial<NewMemoryCandidate> = {}
): MemoryRecord {
  const cand = candidate(type, content, overrides)
  return recordFromCandidate({
    candidate: cand,
    content,
    canonicalKey: canonicalKeyOf({ owner: cand.owner, type, content }),
    recordedAt: T0,
  })
}

// ===========================================================================
// 1. 登记表：默认行为不得改变
// ===========================================================================

group('登记表（M4 的加法不得侵蚀 M2.5）')

test('默认 registry 仍然只有诊断信号一个类型（M2.5 基线不动）', () => {
  const registry = createDefaultDomainEventRegistry()
  expect.deepEqual(registry.types(), ['TEST_CHARACTER_SIGNAL'])
  expect.deepEqual([...REGISTERED_DOMAIN_EVENT_TYPES], ['TEST_CHARACTER_SIGNAL'])
})

test('Memory registry 恰好登记六个类型（计划书第 70 节）', () => {
  const registry = createMemoryDomainEventRegistry()
  expect.deepEqual(registry.types(), [
    MEMORY_CREATED,
    MEMORY_DISPUTED,
    MEMORY_MERGED,
    MEMORY_RESTORED,
    MEMORY_RETRACTED,
    MEMORY_SUPERSEDED,
  ])
  expect.equal(MEMORY_DOMAIN_EVENT_TYPES.length, 6)
})

test('组合表 = 诊断 + Memory，且两者都还在', () => {
  const registry = createFullDomainEventRegistry()
  expect.ok(registry.has('TEST_CHARACTER_SIGNAL'), '组合表丢了诊断信号')
  for (const type of MEMORY_DOMAIN_EVENT_TYPES) {
    expect.ok(registry.has(type), `组合表缺 ${type}`)
  }
})

test('六种 Memory 事件的 payload 契约都会**拒绝**明显非法的输入', () => {
  const registry = createMemoryDomainEventRegistry()

  // 空对象什么都不满足
  for (const type of MEMORY_DOMAIN_EVENT_TYPES) {
    let threw = false
    try {
      registry.get(type)!.validatePayload({})
    } catch {
      threw = true
    }
    expect.ok(threw, `${type} 接受了空 payload —— "失败关闭"被破坏`)
  }

  // MEMORY_MERGED 必须至少有一个 loser（没有败者的"合并"其实是创建）
  let mergedThrew = false
  try {
    registry.get(MEMORY_MERGED)!.validatePayload({
      winnerId: 'mem:a:1',
      loserIds: [],
      reason: 'x',
    })
  } catch {
    mergedThrew = true
  }
  expect.ok(mergedThrew, 'MEMORY_MERGED 接受了空 loserIds')

  // MEMORY_RETRACTED 的 reason 是受控枚举
  let reasonThrew = false
  try {
    registry.get(MEMORY_RETRACTED)!.validatePayload({ memoryId: 'mem:a:1', reason: 'whatever' })
  } catch {
    reasonThrew = true
  }
  expect.ok(reasonThrew, 'MEMORY_RETRACTED 接受了未登记的 reason')

  // MEMORY_CREATED 的 record 必须有证据（MI-03 在 payload 层也守一道）
  let noEvidenceThrew = false
  try {
    registry.get(MEMORY_CREATED)!.validatePayload({
      memoryId: 'mem:a:1',
      mutation: 'explicit',
      record: {
        id: 'mem:a:1',
        owner: { kind: 'character', id: 'c' },
        memoryType: 'preference',
        status: 'active',
        contentFingerprint: 'abc',
        subjects: [USER],
        sourceRefs: [],
        evidenceRootIds: [],
        revision: 1,
      },
    })
  } catch {
    noEvidenceThrew = true
  }
  expect.ok(noEvidenceThrew, 'MEMORY_CREATED 接受了没有证据的 record')
})

// ===========================================================================
// 2. MemoryType / Status / EpistemicStatus 的封闭性
// ===========================================================================

group('受控枚举')

test('MemoryType 恰好四种（计划书第 10 节：不要继续膨胀）', () => {
  expect.deepEqual([...MEMORY_TYPES], ['person_fact', 'preference', 'episode', 'self_experience'])
})

test('MemoryStatus 恰好四种（计划书第 29 节）', () => {
  expect.deepEqual([...MEMORY_STATUSES], ['active', 'superseded', 'retracted', 'disputed'])
})

test('MemoryEpistemicStatus 恰好四种（计划书第 22 节）', () => {
  expect.deepEqual([...MEMORY_EPISTEMIC_STATUSES], ['reported', 'observed', 'inferred', 'generated'])
})

test('MemoryAuthority 恰好六种，且顺序就是权威顺序（计划书第 25–26 节）', () => {
  expect.deepEqual(
    [...MEMORY_AUTHORITIES],
    [
      'EXPLICIT_CORRECTION',
      'EXPLICIT_USER_STATEMENT',
      'DIRECT_INTERACTION',
      'TOOL_OBSERVATION',
      'CHARACTER_GENERATION',
      'MODEL_INFERENCE',
    ]
  )
  // 秩的连续性：六种权威必须占满 0..5，不能有空洞（空洞会让比较静默出错）
  const ranks = MEMORY_AUTHORITIES.map((a) => compareAuthority(a, 'MODEL_INFERENCE'))
  expect.deepEqual(ranks, [-5, -4, -3, -2, -1, 0])
})

test('Claim / Episode 家族划分互斥且完整', () => {
  for (const type of MEMORY_TYPES) {
    const claimSide = isClaimMemoryType(type)
    const episodeSide = isEpisodicMemoryType(type)
    expect.notOk(claimSide && episodeSide, `${type} 同时属于两个家族`)
    expect.ok(claimSide || episodeSide, `${type} 不属于任何家族`)
  }
  expect.ok(isClaimMemoryType('person_fact'))
  expect.ok(isClaimMemoryType('preference'))
  expect.ok(isEpisodicMemoryType('episode'))
  expect.ok(isEpisodicMemoryType('self_experience'))
})

test('SUPERSEDED 与 RETRACTED 的区别可断言：只有前者表示"曾经是真的"', () => {
  // 计划书第 84 节：这条区别是 M4 最重要的一条之一，因此必须能被机器看见。
  // M5 召回时 DISPUTED 可以考虑（它可能是真的、只是有争议），RETRACTED 绝不允许。
  expect.ok(isRecallEligible('active'))
  expect.ok(isRecallEligible('disputed'), 'DISPUTED 应当可以被考虑（它可能是真的）')
  expect.notOk(isRecallEligible('superseded'), 'SUPERSEDED 不该被当作当前状态召回')
  expect.notOk(isRecallEligible('retracted'), 'RETRACTED 绝不进入召回（计划书第 32 节）')
})

test('权威顺序可以比较（EXPLICIT_CORRECTION < EXPLICIT_USER_STATEMENT < ...）', () => {
  expect.ok(compareAuthority('EXPLICIT_CORRECTION', 'EXPLICIT_USER_STATEMENT') < 0)
  expect.ok(compareAuthority('EXPLICIT_USER_STATEMENT', 'MODEL_INFERENCE') < 0)
  expect.ok(compareAuthority('MODEL_INFERENCE', 'EXPLICIT_CORRECTION') > 0)
  expect.equal(compareAuthority('TOOL_OBSERVATION', 'TOOL_OBSERVATION'), 0)
  // 秩的连续性：六种权威必须占满 0..5，不能有空洞（空洞会让比较静默出错）
  expect.deepEqual(
    MEMORY_AUTHORITIES.map((a) => authorityRank(a)),
    [0, 1, 2, 3, 4, 5]
  )
})

test('authorityRank 拒绝未登记的值（否则它会被当成比"纠正"还高的权威）', () => {
  // `Array.indexOf` 找不到时返回 -1，而 -1 在"越小越权威"的约定下
  // 会被解释成**比 EXPLICIT_CORRECTION 还权威**。那是一次静默的越权：
  // 一个拼错的 authority 会让任意断言都放行。
  let threw = false
  let code = ''
  try {
    authorityRank('NOT_A_REAL_AUTHORITY' as never)
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '未登记的权威值被接受 —— 它会被当成最高权威')
  expect.includes(code, 'unknown_memory_authority')
})

// ===========================================================================
// 3. 内容与类型的匹配（计划书第 16 / 20 节）
// ===========================================================================

group('内容与类型匹配')

test('claim × person_fact / preference 合法', () => {
  assertContentMatchesType('person_fact', claim({ predicate: 'education.status', value: 'undergraduate' }))
  assertContentMatchesType('preference', claim())
})

test('episode × episode / self_experience 合法（计划书第 20 节：kind 相同、type 不同）', () => {
  assertContentMatchesType('episode', episode())
  assertContentMatchesType('self_experience', episode())
})

test('交叉组合被拒绝（否则 canonicalKey 会算在没有槽位的形状上）', () => {
  const pairs: [MemoryType, MemoryContent][] = [
    ['person_fact', episode()],
    ['preference', episode()],
    ['episode', claim()],
    ['self_experience', claim()],
  ]
  for (const [type, content] of pairs) {
    let threw = false
    try {
      assertContentMatchesType(type, content)
    } catch (error) {
      threw = String((error as { code?: string }).code).includes('content_type_mismatch')
    }
    expect.ok(threw, `${type} × ${content.kind} 本应被拒绝`)
  }
})

test('构造候选时内容与类型不匹配 → 失败关闭', () => {
  let threw = false
  try {
    createMemoryCandidate({
      owner: CHARACTER,
      type: 'preference',
      content: episode(),
      subjects: [USER],
      sourceRefs: [evidence(1)],
      epistemicStatus: 'reported',
      authority: 'EXPLICIT_USER_STATEMENT',
      importance: 0.5,
      confidence: 0.5,
      processor: 'memory-extractor',
      processorVersion: 'memory-extractor@1',
    })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('content_type_mismatch')
  }
  expect.ok(threw, 'preference × episode 本应被拒绝')
})

// ===========================================================================
// 4. 反污染（计划书第 148 / 149 节，M4 Critical Test）
// ===========================================================================

group('反污染（M4 Critical Test）')

test('计划书第 148 节：「我猜是 8 月 3 日」不能变成用户生日', () => {
  // 这是 M4 最重要的一条。它必须**在结构上**不可能，而不是靠 prompt 里的一句叮嘱。
  let threw = false
  let code = ''
  try {
    assertMemoryAuthorityAllows({
      authority: 'CHARACTER_GENERATION',
      type: 'person_fact',
      epistemicStatus: 'generated',
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '她的猜测被允许建立 PERSON_FACT —— M4 Critical Test 失败')
  expect.includes(code, 'authority_cannot_establish_person_fact')
})

test('MODEL_INFERENCE 不能建立 PERSON_FACT / PREFERENCE（计划书第 27 节）', () => {
  for (const type of ['person_fact', 'preference'] as const) {
    for (const authority of ['MODEL_INFERENCE', 'CHARACTER_GENERATION', 'TOOL_OBSERVATION', 'DIRECT_INTERACTION'] as const) {
      let threw = false
      try {
        assertMemoryAuthorityAllows({ authority, type, epistemicStatus: 'inferred' })
      } catch {
        threw = true
      }
      expect.ok(threw, `${type} 被 ${authority} 建立 —— 计划书第 27 节禁止`)
    }
  }
})

test('EXPLICIT_USER_STATEMENT / EXPLICIT_CORRECTION 可以建立用户事实', () => {
  for (const authority of ['EXPLICIT_USER_STATEMENT', 'EXPLICIT_CORRECTION'] as const) {
    assertMemoryAuthorityAllows({ authority, type: 'person_fact', epistemicStatus: 'reported' })
    assertMemoryAuthorityAllows({ authority, type: 'preference', epistemicStatus: 'reported' })
  }
  expect.ok(canEstablishUserFact('EXPLICIT_USER_STATEMENT'))
  expect.ok(canEstablishUserFact('EXPLICIT_CORRECTION'))
  expect.notOk(canEstablishUserFact('DIRECT_INTERACTION'))
})

test('计划书第 149 节：她自述的"小时候"不能变成 SELF_EXPERIENCE', () => {
  let threw = false
  try {
    assertMemoryAuthorityAllows({
      authority: 'CHARACTER_GENERATION',
      type: 'self_experience',
      epistemicStatus: 'generated',
    })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes(
      'authority_cannot_establish_self_experience'
    )
  }
  expect.ok(threw, '她编的童年被允许存成 SELF_EXPERIENCE')
})

test('计划书第 150 节：真实发生过的共同经历**可以**成为 EPISODE/SELF_EXPERIENCE', () => {
  // 反向断言。少了它会得到一个"一律不记经历"的过度修正，
  // 而 M4 的目标是"只记值得记的"，不是"什么都不记"。
  assertMemoryAuthorityAllows({
    authority: 'DIRECT_INTERACTION',
    type: 'episode',
    epistemicStatus: 'observed',
  })
  assertMemoryAuthorityAllows({
    authority: 'DIRECT_INTERACTION',
    type: 'self_experience',
    epistemicStatus: 'observed',
  })
})

test('MODEL_INFERENCE 不能建立 Episode（一段"经历"要么真发生，要么不该记）', () => {
  let threw = false
  try {
    assertMemoryAuthorityAllows({
      authority: 'MODEL_INFERENCE',
      type: 'episode',
      epistemicStatus: 'inferred',
    })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('inference_cannot_establish_episode')
  }
  expect.ok(threw, '推断出的"经历"被允许')
})

// ===========================================================================
// 5. 权威映射（审计 §4 D1 的两条硬规则）
// ===========================================================================

group('权威映射')

test('用户明确陈述与用户确认映射到同一级（对用户事实而言强度同级）', () => {
  expect.equal(authorityFromSource('USER_EXPLICIT'), 'EXPLICIT_USER_STATEMENT')
  expect.equal(authorityFromSource('USER_REPLY_CONFIRMATION'), 'EXPLICIT_USER_STATEMENT')
})

test('EXPLICIT_CORRECTION **不能**由"来源是用户"推导出来', () => {
  // 硬规则 1：它只能由显式纠正路径**授予**
  expect.equal(
    authorityFromSource('USER_EXPLICIT'),
    'EXPLICIT_USER_STATEMENT',
    '普通用户陈述不该直接得到纠正级权威'
  )
  expect.equal(
    authorityFromSource('USER_EXPLICIT', { isExplicitCorrection: true }),
    'EXPLICIT_CORRECTION'
  )
})

test('SYSTEM_INSTRUCTION 映射失败关闭（计划书第 84 节）', () => {
  let threw = false
  let code = ''
  try {
    authorityFromSource('SYSTEM_INSTRUCTION')
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, 'SYSTEM_INSTRUCTION 被映射成了某种权威 —— 它会让系统提示变成她的记忆')
  expect.includes(code, 'system_instruction_cannot_become_memory_authority')

  // 关键：**不许**回落到 MODEL_INFERENCE ——
  // 回落是最危险的做法，它把"我们不知道它算什么"悄悄变成"它算模型推断"，
  // 于是那条记忆照样进库，只是权威低一点。
  let fellBack = false
  try {
    authorityFromSource('SYSTEM_INSTRUCTION')
    fellBack = true
  } catch {
    /* 预期 */
  }
  expect.notOk(fellBack)
})

test('其余三种映射是恒等', () => {
  expect.equal(authorityFromSource('DIRECT_INTERACTION'), 'DIRECT_INTERACTION')
  expect.equal(authorityFromSource('TOOL_OBSERVATION'), 'TOOL_OBSERVATION')
  expect.equal(authorityFromSource('CHARACTER_GENERATION'), 'CHARACTER_GENERATION')
})

// ===========================================================================
// 6. Evidence 三条失败关闭（MI-03 / 计划书第 40–41 节）
// ===========================================================================

group('证据（MI-03）')

test('没有 sourceRefs → 拒绝', () => {
  let threw = false
  try {
    assertMemoryEvidence({ sourceRefs: [], evidenceRootIds: ['x'] })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('memory_without_evidence')
  }
  expect.ok(threw, '一条没有证据的长期记忆被允许')
})

test('没有 evidenceRootIds → 拒绝（计划书第 40 节：防 Reflection 自我强化）', () => {
  let threw = false
  try {
    assertMemoryEvidence({ sourceRefs: [evidence(1)], evidenceRootIds: [] })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('memory_without_evidence_root')
  }
  expect.ok(threw, '没有根证据的记忆被允许')
})

test('根证据不在来源里 → 拒绝（计划书第 41 节：不许伪造成新的独立证据）', () => {
  let threw = false
  try {
    assertMemoryEvidence({
      sourceRefs: [evidence(1)],
      evidenceRootIds: [evidence(2).id],
    })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('evidence_root_not_in_sources')
  }
  expect.ok(threw, '伪造根证据被允许')
})

test('缺省 evidenceRootIds = sourceRefs 的 id（这是**正确**的缺省，不是省事）', () => {
  // 计划书第 40 节的例子正是 ConversationEvent ——
  // 候选直接来自真实事件时，那些事件**就是**根证据。
  const cand = candidate('preference', claim())
  expect.deepEqual(cand.evidenceRootIds, [evidence(1).id])
})

test('派生记忆必须继承更早的根（计划书第 41 节的强形式现在就写好断言）', () => {
  // M4 还没有 A→B 的派生链（那是 M11 Reflection），
  // 但断言函数现在就存在并测试，这样 M11 不能"顺手"把它写松。
  //
  // 场景：Memory B 基于"对 A 的总结"产生，而 A 的根是 Event #1。
  // 因此 B 的 sourceRefs 必须**同时**包含 Event #3（本次总结）与 Event #1（更早的根）。
  const derived = createMemoryCandidate({
    owner: CHARACTER,
    type: 'episode',
    content: episode(),
    subjects: [CHARACTER, USER],
    sourceRefs: [evidence(3), evidence(1)],
    evidenceRootIds: [evidence(1).id],
    epistemicStatus: 'observed',
    authority: 'DIRECT_INTERACTION',
    importance: 0.6,
    confidence: 0.7,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
  expect.deepEqual(derived.evidenceRootIds, [evidence(1).id])
  expect.ok(
    derived.sourceRefs.some((ref) => ref.id === evidence(1).id),
    '更早的根必须同时在 sourceRefs 里，否则它就不是"继承"而是"凭空引用"'
  )
  expect.ok(
    derived.sourceRefs.some((ref) => ref.id === evidence(3).id),
    '本次总结来源也必须保留'
  )

  // 反向：声称的根**不在**本次来源里 → 拒绝（计划书第 41 节：不许伪造成新的独立证据）
  let threw = false
  try {
    createMemoryCandidate({
      owner: CHARACTER,
      type: 'episode',
      content: episode(),
      subjects: [CHARACTER, USER],
      sourceRefs: [evidence(3)],
      evidenceRootIds: [evidence(99).id],
      epistemicStatus: 'observed',
      authority: 'DIRECT_INTERACTION',
      importance: 0.6,
      confidence: 0.7,
      processor: 'memory-extractor',
      processorVersion: 'memory-extractor@1',
    })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('evidence_root_not_in_sources')
  }
  expect.ok(threw, '凭空引用了不属于来源的根证据')
})

// ===========================================================================
// 7. CanonicalMemoryKey（计划书第 18 / 34 / 76 / 152 节）
// ===========================================================================

group('CanonicalMemoryKey')

test('Claim 有槽位键，Episode 没有（它不是一个事实槽位）', () => {
  expect.ok(canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() }))
  expect.ok(canonicalKeyOf({ owner: CHARACTER, type: 'person_fact', content: claim() }))
  expect.equal(canonicalKeyOf({ owner: CHARACTER, type: 'episode', content: episode() }), undefined)
  expect.equal(
    canonicalKeyOf({ owner: CHARACTER, type: 'self_experience', content: episode() }),
    undefined
  )
})

test('槽位键**不含取值** —— 这正是"喜欢咖啡"与"戒咖啡"能落到同一槽位的原因', () => {
  const likes = claim({ value: 'like' })
  const dislikes = claim({ value: 'dislike' })
  expect.equal(
    canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: likes }),
    canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: dislikes }),
    '同一个槽位的两个取值算出了不同的 key —— 冲突检测会完全失效'
  )
})

test('不同 subject → 不同槽位（计划书第 8 节：不许把 user 写死）', () => {
  const mine = canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() })
  const theirs = canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ subject: OTHER_USER }),
  })
  expect.notOk(mine === theirs, '两个用户的同一 predicate 算出了同一个槽位')
})

test('不同 predicate → 不同槽位', () => {
  const food = canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() })
  const edu = canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ predicate: 'education.status', value: 'undergraduate' }),
  })
  expect.notOk(food === edu)
})

test('不同 owner → 不同槽位（未来多角色各占自己的 Memory Space）', () => {
  const byHer = canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() })
  const byOther = canonicalKeyOf({
    owner: entityRef('character', 'char_other'),
    type: 'preference',
    content: claim(),
  })
  expect.notOk(byHer === byOther)
})

test('计划书第 152 节：qualifier 不同的偏好是**两个槽位**，不能合并', () => {
  // 「技术问题我喜欢详细解释，普通闲聊简单点就行」
  // 必须落成两条 qualifier 不同的 ACTIVE 记忆，
  // 而不是被合并成一条"用户喜欢详细"。
  const technical = canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'preferred_explanation_style',
      value: 'detailed',
      qualifiers: { context: 'technical' },
    },
  })
  const casual = canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'preferred_explanation_style',
      value: 'brief',
      qualifiers: { context: 'casual' },
    },
  })
  expect.ok(technical !== undefined && casual !== undefined)
  expect.notOk(technical === casual, '两个不同上下文的偏好被合并成了同一个槽位')

  // 而 qualifier **取值**不进 key：同一个上下文下 detailed/brief 是同一槽位
  const technicalBrief = canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'preferred_explanation_style',
      value: 'brief',
      qualifiers: { context: 'technical' },
    },
  })
  expect.equal(
    technical,
    technicalBrief,
    '同一个 qualifier 上下文下的两个取值应当是同一槽位（它们是 supercede 关系）'
  )

  // 没有 qualifier 的偏好与有 qualifier 的偏好**也是不同槽位**
  // （"我喜欢详细解释"是全局偏好，"技术问题要详细"是带条件的偏好）
  const global = canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ predicate: 'preferred_explanation_style', value: 'detailed' }),
  })
  expect.notOk(global === technical, '全局偏好与条件偏好被合并了')

  // qualifier 数不影响：同一个 content 重复算两次必须一致
  expect.equal(technical, canonicalKeyOf({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'preferred_explanation_style',
      value: 'detailed',
      qualifiers: { context: 'technical' },
    },
  }))
})

test('type 进槽位键：person_fact 与 preference 不共用槽位', () => {
  const asFact = canonicalKeyOf({ owner: CHARACTER, type: 'person_fact', content: claim() })
  const asPref = canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() })
  expect.notOk(asFact === asPref)
})

test('canonicalKey 是稳定摘要（同一输入永远得到同一结果）', () => {
  const a = canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() })
  const b = canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: claim() })
  expect.equal(a, b)
  expect.equal(typeof a, 'string')
  expect.equal((a as string).length, 16, '摘要长度应当是 16 位十六进制')
})

test('内容与类型不匹配时 canonicalKeyOf 抛错（不静默算一个假槽位）', () => {
  let threw = false
  try {
    canonicalKeyOf({ owner: CHARACTER, type: 'preference', content: episode() })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('content_type_mismatch')
  }
  expect.ok(threw)
})

// ===========================================================================
// 8. 内容指纹（计划书第 75 节去重第一层）
// ===========================================================================

group('内容指纹')

test('指纹**含取值** —— 与槽位键的分工正是 M4 去重的两层', () => {
  const likes = contentFingerprintOf({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ value: 'like' }),
    subjects: [USER],
  })
  const dislikes = contentFingerprintOf({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ value: 'dislike' }),
    subjects: [USER],
  })
  expect.notOk(likes === dislikes, '取值不同却算出同一指纹 —— 第一层去重会误判')
})

test('完全相同的内容 → 同一指纹（第一层去重据此 REJECT_DUPLICATE）', () => {
  const mk = () =>
    contentFingerprintOf({
      owner: CHARACTER,
      type: 'preference',
      content: claim(),
      subjects: [USER],
    })
  expect.equal(mk(), mk())
})

test('subjects 的**顺序**不影响指纹（集合语义，不是数组语义）', () => {
  // 一段共同经历的两个参与者，谁先谁后不是语义差别。
  const a = contentFingerprintOf({
    owner: CHARACTER,
    type: 'episode',
    content: episode(),
    subjects: [CHARACTER, USER],
  })
  const b = contentFingerprintOf({
    owner: CHARACTER,
    type: 'episode',
    content: episode(),
    subjects: [USER, CHARACTER],
  })
  expect.equal(a, b, '参与者顺序改变了指纹 —— 同一段经历会被记两次')
})

test('Episode 的内容变化会改变指纹（第一层抓不到时交给第三层）', () => {
  const a = contentFingerprintOf({
    owner: CHARACTER,
    type: 'episode',
    content: episode(),
    subjects: [CHARACTER, USER],
  })
  const b = contentFingerprintOf({
    owner: CHARACTER,
    type: 'episode',
    content: episode({ summary: '他们聊了别的事情' }),
    subjects: [CHARACTER, USER],
  })
  expect.notOk(a === b)
})

// ===========================================================================
// 9. 稳定序列化
// ===========================================================================

group('稳定序列化')

test('对象键顺序不影响结果（计划书第 19 节"足够稳定即可"的前提）', () => {
  expect.equal(stableMaterial({ a: 1, b: 2 }), stableMaterial({ b: 2, a: 1 }))
})

test('嵌套对象同样排序', () => {
  expect.equal(
    stableMaterial({ x: { a: 1, b: 2 } }),
    stableMaterial({ x: { b: 2, a: 1 } })
  )
})

test('数组顺序**保留**（数组是序列，不是集合）', () => {
  expect.notOk(stableMaterial([1, 2]) === stableMaterial([2, 1]))
})

test('undefined 与 null 可区分', () => {
  expect.notOk(stableMaterial(undefined) === stableMaterial(null))
})

test('NaN / Infinity 被拒绝而不是静默变成 "null"', () => {
  // 静默变成 null 会让两条不同的记忆撞上同一个指纹 —— 那是**不报错**的缺陷。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    let threw = false
    try {
      stableMaterial({ v: bad })
    } catch (error) {
      threw = String((error as { code?: string }).code).includes('non_finite_in_material')
    }
    expect.ok(threw, `${bad} 被静默序列化了`)
  }
})

test('不支持的类型抛错（而不是变成 [object Object]）', () => {
  let threw = false
  try {
    stableMaterial({ f: () => 1 })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('unsupported_material_value')
  }
  expect.ok(threw, '函数被静默序列化了 —— 两条不同记忆可能撞指纹')
})

test('中文与 emoji 得到稳定结果', () => {
  const a = stableMaterial({ text: '她记得香菜这件事 🥬' })
  const b = stableMaterial({ text: '她记得香菜这件事 🥬' })
  expect.equal(a, b)
})

test('memoryDigest 对同一材料稳定、对不同材料不同', () => {
  expect.equal(memoryDigest('abc'), memoryDigest('abc'))
  expect.notOk(memoryDigest('abc') === memoryDigest('abd'))
  expect.equal(memoryDigest('abc').length, 16)
})

// ===========================================================================
// 10. MemoryId 的确定性派生（审计 §6 F4 的落地点）
// ===========================================================================

group('MemoryId 派生（幂等的关键）')

test('同一件事 → 同一个 id（重跑不会产生第二条记忆）', () => {
  const slot = () =>
    memorySlotFor({
      owner: CHARACTER,
      type: 'preference',
      content: claim(),
      subjects: [USER],
    })
  expect.equal(slot(), slot())

  const id1 = makeMemoryId('char_sumuwei' as never, slot())
  const id2 = makeMemoryId('char_sumuwei' as never, slot())
  expect.equal(id1, id2)
})

test('**同一批里的不同候选必须得到不同 id**（审计 §6 F4 的核心）', () => {
  // 这是 M4 最容易做错的一处：若幂等键里没有"哪条记忆"这个分量，
  // 同一批事件产出的多条候选会算出同一个键，于是第 2、3 条会被
  // 判成 duplicate_operation 而**静默丢弃**。
  const a = memorySlotFor({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ predicate: 'food.preference.cilantro', value: 'dislike' }),
    subjects: [USER],
  })
  const b = memorySlotFor({
    owner: CHARACTER,
    type: 'person_fact',
    content: claim({ predicate: 'education.status', value: 'undergraduate' }),
    subjects: [USER],
  })
  const c = memorySlotFor({
    owner: CHARACTER,
    type: 'episode',
    content: episode(),
    subjects: [CHARACTER, USER],
  })
  const slots = [a, b, c]
  expect.equal(new Set(slots).size, 3, '三条不同候选算出了重复的 slot')
})

test('不同取值 → 不同 id（"喜欢咖啡"与"戒咖啡"必须是两条记忆）', () => {
  const likes = memorySlotFor({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ value: 'like' }),
    subjects: [USER],
  })
  const dislikes = memorySlotFor({
    owner: CHARACTER,
    type: 'preference',
    content: claim({ value: 'dislike' }),
    subjects: [USER],
  })
  expect.notOk(likes === dislikes, '跨取值更新会因此找不到目标（应靠 canonicalKey，不靠 id）')
})

test('不同 owner 的同一内容 → 不同 id（Memory Space 隔离）', () => {
  const hers = memorySlotFor({
    owner: CHARACTER,
    type: 'preference',
    content: claim(),
    subjects: [USER],
  })
  const other = memorySlotFor({
    owner: entityRef('character', 'char_other'),
    type: 'preference',
    content: claim(),
    subjects: [USER],
  })
  expect.notOk(hers === other)
})

test('makeMemoryId 拒绝空 slot（空 slot 会让所有记忆挤进同一个 id）', () => {
  let threw = false
  try {
    makeMemoryId('char_sumuwei' as never, '   ')
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('empty_memory_slot')
  }
  expect.ok(threw)
})

test('owner 必须是 character（计划书第 7 节：Memory Space 属于角色）', () => {
  expect.equal(String(ownerCharacterId(CHARACTER)), 'char_sumuwei')
  let threw = false
  try {
    ownerCharacterId(USER)
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('memory_owner_not_character')
  }
  expect.ok(threw, 'user 被允许当作 owner —— "她的记忆"与"用户的资料"将无法区分')
})

// ===========================================================================
// 11. predicate 登记表（计划书第 19 节）
// ===========================================================================

group('predicate 登记表')

test('规范化：大小写、空白、重复分隔符', () => {
  expect.equal(normalizePredicate('  Food.Preference.Cilantro  '), 'food.preference.cilantro')
  expect.equal(normalizePredicate('food..preference.cilantro'), 'food.preference.cilantro')
  expect.equal(normalizePredicate('food.preference.cilantro.'), 'food.preference.cilantro')
  expect.equal(normalizePredicate('preferred explanation style'), 'preferred.explanation.style')
  expect.equal(normalizePredicate('food_preference_cilantro'), 'food.preference.cilantro')
})

test('规范化为空 → 拒绝（没有槽位键就无法做冲突检测）', () => {
  for (const bad of ['', '   ', '.', '...']) {
    let threw = false
    try {
      normalizePredicate(bad)
    } catch (error) {
      threw = String((error as { code?: string }).code).includes('empty_predicate')
    }
    expect.ok(threw, `${JSON.stringify(bad)} 被接受为空 predicate`)
  }
})

test('计划书第 18 / 174 节的槽位已登记', () => {
  const keys = registeredPredicates().map((spec) => spec.key)
  expect.ok(keys.includes('food.preference.cilantro'), 'M4-001/002 用的槽位没登记')
  expect.ok(keys.includes('education.status'))
  expect.ok(keys.includes('education.major'), 'M4-002 的纠正场景用的槽位没登记')
  expect.ok(
    keys.includes('preferred.explanation.style'),
    '计划书第 152 节的槽位没登记'
  )
})

test('登记键必须是规范化形式，否则它永远查不到（实测踩到过的真实缺陷）', () => {
  // `preferred_explanation_style` 这类写法会被 normalizePredicate 转成点号，
  // 于是"登记的键"与"查表的键"永远不相等。它不报错、不告警，只是静静不生效。
  // 现在这条由 memory-predicates.ts 的模块加载期断言 + 这条测试双重守住。
  for (const spec of registeredPredicates()) {
    expect.equal(
      normalizePredicate(spec.key),
      spec.key,
      `${spec.key} 不是规范化形式 —— 它会永远查不到`
    )
  }

  // 具体回归：那个曾经写错的键，两种写法必须都能查到同一个槽位
  expect.equal(
    normalizePredicate('preferred_explanation_style'),
    normalizePredicate('preferred.explanation.style')
  )
  const lookup = registeredPredicates().find(
    (s) => s.key === normalizePredicate('preferred_explanation_style')
  )
  expect.ok(lookup !== undefined, '下划线写法查不到那个槽位')
})

test('登记表里的每个键都是规范化形式（否则"已登记"是谎话）', () => {
  for (const spec of registeredPredicates()) {
    expect.equal(normalizePredicate(spec.key), spec.key, `登记键 ${spec.key} 不是规范化形式`)
    expect.ok(spec.description.trim() !== '', `${spec.key} 没有说明`)
    expect.ok(spec.examples.length > 0, `${spec.key} 没有例句`)
  }
})

test('登记表是**只增**的：不允许重复键', () => {
  const keys = registeredPredicates().map((s) => s.key)
  expect.equal(new Set(keys).size, keys.length, '登记表里有重复键')
})

test('未登记的键**允许写入**，但标记出来（计划书第 19 节"足够稳定即可"）', () => {
  // 这是刻意的中间路线：严格封闭会静默丢掉本该记住的事实，
  // 完全自由会让同一件事分散在三个槽位。
  const result = validateClaimContent({
    content: claim({ predicate: 'some.brand.new.slot', value: 'whatever' }),
    subjects: [USER],
  })
  expect.equal(result.predicateKind, 'unregistered')
  expect.equal(result.predicate, 'some.brand.new.slot')
  expect.equal(result.spec, undefined)
})

test('已登记的键给出 spec，且 predicate 被规范化后写回', () => {
  const content = claim({ predicate: 'Food.Preference.Cilantro', value: 'dislike' })
  const result = validateClaimContent({ content, subjects: [USER] })
  expect.equal(result.predicateKind, 'registered')
  expect.equal(result.predicate, 'food.preference.cilantro')
  expect.ok(result.spec !== undefined)
})

test('取值不在合法集合内 → 只告警不拒绝（硬拒会丢掉真实事实）', () => {
  const content = claim({ predicate: 'food.preference.cilantro', value: 'complicated' })
  const result = validateClaimContent({ content, subjects: [USER] })
  expect.equal(result.predicateKind, 'registered')
  expect.ok(result.shapeWarning !== undefined, '非法取值应当产生告警')
  expect.includes(String(result.shapeWarning), 'food.preference.cilantro')
})

test('valueFitsShape 接受合法取值与带限定词的形状', () => {
  const specs = registeredPredicates()
  const cilantro = specs.find((s) => s.key === 'food.preference.cilantro')!
  expect.ok(valueFitsShape(cilantro, 'dislike').fits)
  expect.ok(valueFitsShape(cilantro, 'DISLIKE').fits, '大小写不该影响判定')
  expect.notOk(valueFitsShape(cilantro, 'complicated').fits)
  // 带限定词的形状 { value: 'like', note: '...' }
  expect.ok(valueFitsShape(cilantro, { value: 'like' }).fits)
})

test('没有 allowed 的槽位不限制取值', () => {
  const specs = registeredPredicates()
  const background = specs.find((s) => s.key === 'project.background.active')
  expect.ok(background !== undefined, 'project.background.active 没登记')
  expect.ok(valueFitsShape(background!, '任何文本都可以').fits)
  expect.ok(valueFitsShape(background!, { anything: 1 }).fits)
})

test('测试注入的 predicate 在回调后**必须**被清掉（不污染生产表）', () => {
  // M3.5 审计明确反对"为一个测试在生产枚举里塞假值"。
  // 这里用显式注入 + 显式清理，并断言清理真的生效。
  const before = registeredPredicates().length
  const restore = registerPredicateForTest({
    key: 'test.only.slot',
    description: '测试专用',
    valueShape: 'enum',
    allowed: ['a', 'b'],
    examples: ['x'],
  })
  expect.equal(registeredPredicates().length, before + 1, '注入没生效')
  expect.ok(registeredPredicates().some((s) => s.key === 'test.only.slot'))

  restore()
  expect.equal(registeredPredicates().length, before, '测试注入的 predicate 没有被清理')
  expect.notOk(registeredPredicates().some((s) => s.key === 'test.only.slot'))
})

// ===========================================================================
// 12. content.subject 与 subjects[0] 的一致性
// ===========================================================================

group('Claim 的 subject 一致性')

test('content.subject 与 subjects[0] 不一致 → 拒绝', () => {
  let threw = false
  try {
    validateClaimContent({
      content: claim({ subject: OTHER_USER }),
      subjects: [USER],
    })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('claim_subject_mismatch')
  }
  expect.ok(threw, '两处表达"讲的是谁"不一致却被接受 —— 它们有一天会对不上')
})

test('Claim 没有 subjects → 拒绝', () => {
  let threw = false
  try {
    validateClaimContent({ content: claim(), subjects: [] })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('claim_without_subject')
  }
  expect.ok(threw)
})

test('一致时通过', () => {
  validateClaimContent({ content: claim(), subjects: [USER] })
})

// ===========================================================================
// 13. Episode 结构校验（计划书第 13 / 20 节）
// ===========================================================================

group('Episode 结构')

test('summary 为空 → 拒绝', () => {
  let threw = false
  try {
    validateEpisodicContent({ type: 'episode', content: episode({ summary: '   ' }) })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('episode_without_summary')
  }
  expect.ok(threw)
})

test('没有 participants → 拒绝', () => {
  let threw = false
  try {
    validateEpisodicContent({ type: 'episode', content: episode({ participants: [] }) })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('episode_without_participants')
  }
  expect.ok(threw)
})

test('没有 eventRefs → 拒绝（否则它与编造无法区分）', () => {
  let threw = false
  try {
    validateEpisodicContent({ type: 'episode', content: episode({ eventRefs: [] }) })
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('episode_without_event_refs')
  }
  expect.ok(threw)
})

test('合法 Episode 通过', () => {
  validateEpisodicContent({ type: 'episode', content: episode() })
  validateEpisodicContent({ type: 'self_experience', content: episode() })
})

// ===========================================================================
// 14. importance / confidence 是两个独立字段（计划书第 52 节）
// ===========================================================================

group('importance ≠ confidence（计划书第 52 节）')

test('两者都必须在 [0,1] 且有限', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['importance NaN', { importance: Number.NaN }],
    ['importance > 1', { importance: 1.5 }],
    ['importance < 0', { importance: -0.1 }],
    ['confidence NaN', { confidence: Number.NaN }],
    ['confidence > 1', { confidence: 2 }],
    ['confidence < 0', { confidence: -1 }],
  ]
  for (const [label, override] of cases) {
    let threw = false
    try {
      candidate('preference', claim(), override as never)
    } catch (error) {
      threw =
        String((error as { code?: string }).code).includes('bad_importance') ||
        String((error as { code?: string }).code).includes('bad_confidence')
    }
    expect.ok(threw, `${label} 被接受了`)
  }
})

test('高 confidence + 低 importance 可以被表达（"我今天午饭吃了面"）', () => {
  // 计划书第 52 节的例子。若两者被合并成一个字段，
  // 这种"确定但没价值"的输入就只能二选一，于是要么丢掉确定性、要么记住垃圾。
  const cand = candidate('person_fact', claim({ predicate: 'lunch.today', value: 'noodles' }), {
    confidence: 0.99,
    importance: 0.05,
  } as never)
  expect.equal(cand.confidence, 0.99)
  expect.equal(cand.importance, 0.05)
})

// ===========================================================================
// 15. 候选 → 记录的转换（只走 reducer 会走的那条路）
// ===========================================================================

group('候选 → 记录')

test('新记录状态是 ACTIVE，validUntil 明确是 null（"没有终点"而不是"不知道"）', () => {
  const rec = record('preference', claim())
  expect.equal(rec.status, 'active')
  expect.equal(rec.validUntil, null, '新建的当前事实应当明确"没有终点"，而不是 undefined')
  expect.equal(rec.revision, 1)
})

test('记录带上 reducerVersion 与 schemaVersion（改了语义必须先 rebuild）', () => {
  const rec = record('preference', claim())
  expect.equal(rec.reducerVersion, 'memory-reducer@1')
  expect.equal(rec.schemaVersion, 1)
})

test('Claim 记录有 canonicalKey，Episode 记录没有', () => {
  expect.ok(record('preference', claim()).canonicalKey !== undefined)
  expect.equal(record('episode', episode()).canonicalKey, undefined)
})

test('每条记录都有材料指纹与证据', () => {
  const rec = record('preference', claim())
  expect.ok(rec.contentFingerprint.length === 16)
  expect.ok(rec.sourceRefs.length > 0)
  expect.ok(rec.evidenceRootIds.length > 0)
})

test('「我们曾经讨论过 AI Agent」有两个主体（计划书第 8 节的例子）', () => {
  const rec = record('episode', episode())
  expect.equal(rec.subjects.length, 2)
})

// ===========================================================================
// 16. Reducer 元信息（声明与实现必须一致）
// ===========================================================================

group('Reducer 元信息')

test('createMemoryReducer 的 version 与 handledEventTypes 与实际一致', () => {
  const reducer = createMemoryReducer()
  expect.equal(reducer.version, 'memory-reducer@1')
  expect.deepEqual([...reducer.handledEventTypes].sort(), [...MEMORY_DOMAIN_EVENT_TYPES].sort())
  expect.equal(reducer.version, MEMORY_REDUCER_VERSION)
})

test('**声明了 handled 就必须有分支** —— 缺一个会抛错而不是静默跳过', () => {
  /*
   * 这条守的是"声明与实现不一致"这类缺陷。
   *
   * 若 `MEMORY_HANDLED_EVENT_TYPES` 里有一个类型而 `reduceMemory` 没有它的分支，
   * 那么那条状态变化会被**静默跳过** —— trace 上看起来一切正常，
   * 只是某个状态永远不更新。这类缺陷不崩溃、只出错，是最难查的一种。
   *
   * 因此给六个类型各造一条最小事件，断言它们都能被处理（不抛 unhandled）。
   */
  const reducer = createMemoryReducer()
  const cases: { type: string; payload: Record<string, unknown> }[] = [
    {
      type: MEMORY_CREATED,
      payload: {
        memoryId: 'mem:test:1',
        mutation: 'explicit',
        record: record('preference', claim()),
      },
    },
    { type: MEMORY_SUPERSEDED, payload: { memoryId: 'mem:test:1', supersededBy: 'mem:test:2', validUntil: 1, reason: 'x' } },
    { type: MEMORY_RETRACTED, payload: { memoryId: 'mem:test:1', reason: 'explicit_forget' } },
    { type: MEMORY_DISPUTED, payload: { memoryId: 'mem:test:1', conflictingMemoryIds: [], reason: 'x' } },
    { type: MEMORY_MERGED, payload: { winnerId: 'mem:test:1', loserIds: ['mem:test:2'], reason: 'x' } },
    { type: MEMORY_RESTORED, payload: { memoryId: 'mem:test:1', reason: 'x' } },
  ]

  for (const c of cases) {
    const event = {
      id: `dev:test:${c.type}`,
      characterId: 'char_sumuwei',
      sequence: 1,
      type: c.type,
      sourceConversationEventIds: ['cev:char_sumuwei:conv:1'],
      payload: c.payload,
      processor: 'test',
      processorVersion: 'test@1',
      idempotencyKey: 'idem:test',
      schemaVersion: 1,
      createdAt: T0,
    } as unknown as Parameters<typeof reducer.reduce>[1]

    // 对"已存在记忆"类事件，给一个非 null 的起始状态；
    // CREATED 给 null（从零开始）
    const start = c.type === MEMORY_CREATED ? null : record('preference', claim())
    let message = ''
    try {
      reducer.reduce(start, event)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect.notIncludes(message, 'memory_event_type_unhandled', `${c.type} 没有被 reducer 处理`)
  }
})

test('未登记的事件类型不会被 reducer 处理（changed=false，不抛错）', () => {
  const reducer = createMemoryReducer()
  const foreign = {
    type: 'TEST_CHARACTER_SIGNAL',
    payload: { counterDelta: 1 },
    sequence: 1,
    createdAt: T0,
  } as unknown as Parameters<typeof reducer.reduce>[1]
  const result = reducer.reduce(null, foreign)
  expect.equal(result.changed, false)
  expect.equal(result.record, null)
})

// ===========================================================================
// 17. 显式意图检测（计划书第 54–60 节，Phase 4）
// ===========================================================================

group('显式意图检测（规则优先）')

test('计划书第 60 节列出的关键词都能被识别', () => {
  // 计划书第 60 节原文给的清单：记住 / 记一下 / 别忘了 / 之前记错了 /
  // 改成 / 忘掉 / 不要再记
  const cases: [string, string][] = [
    ['记住，我不吃香菜', 'remember'],
    ['记一下我的学号是 12345', 'remember'],
    ['别忘了我不吃香菜', 'remember'],
    ['之前记错了，我不是计算机专业', 'correct'],
    ['把那个改成我现在能吃香菜了', 'correct'],
    ['忘掉我关于香菜的偏好', 'forget'],
    ['不要再记这件事了', 'forget'],
  ]
  for (const [text, expected] of cases) {
    const intent = detectByRule(text)
    expect.ok(intent !== undefined, `「${text}」没有被识别出显式意图`)
    expect.equal(intent!.kind, expected, `「${text}」被识别成 ${intent!.kind}，期望 ${expected}`)
  }
})

test('**否定必须优先于肯定**（"不要再记" 不得被读成 "记住"）', () => {
  /*
   * 这是本组最重要的一条。
   *
   * "不要再记了" 里含 "记"，"之前记错了" 里也含 "记"。
   * 若 `remember` 规则先判，这两句都会被当成"记住" ——
   * 而那是把用户的**否定**读成了**肯定**，后果与用户意图相反。
   *
   * 顺序由 `MEMORY_INTENT_RULES` 的数组排列保证，这条测试守住那个排列。
   */
  const negatives: [string, string][] = [
    ['不要再记这件事了', 'forget'],
    ['别记了', 'forget'],
    ['之前记错了', 'correct'],
    ['你记错了我的专业', 'correct'],
  ]
  for (const [text, expected] of negatives) {
    const intent = detectByRule(text)
    expect.equal(intent?.kind, expected, `「${text}」被读成 ${intent?.kind} —— 否定被读成了肯定`)
  }
})

test('规则表的顺序就是不变量：forget / correct 必须排在 remember 之前', () => {
  const order = MEMORY_INTENT_RULES.map((r) => r.kind)
  const rememberAt = order.indexOf('remember')
  expect.ok(order.indexOf('forget') < rememberAt, 'forget 排在 remember 之后')
  expect.ok(order.indexOf('correct') < rememberAt, 'correct 排在 remember 之后')
})

test('普通对话**不会**被误判成显式意图（误判会把闲聊变成记忆写入）', () => {
  const chitchat = [
    '你好啊',
    '今天天气不错',
    '哈哈',
    '嗯',
    '好的',
    '我记住了', // ← 这是"我"记住了，不是用户在要求记住
    '你记得上次那个事吗',
  ]
  for (const text of chitchat) {
    const intent = detectByRule(text)
    expect.equal(intent, undefined, `「${text}」被误判成 ${intent?.kind}`)
  }
})

test('★ 正控（WP4 `D-55a`）：**句首**的更正同义说法必须判成 correct', () => {
  /*
   * 这一条守的是"词表缺口"那类缺陷：缺口的表现不是丢事实，而是**用户的更正被静默丢弃**
   * （实测：「更正一下，我现在吃辣了。」曾整轮没有任何记忆操作）。
   */
  const leading: [string, string][] = [
    ['更正一下，我现在吃辣了。', 'correct'],
    ['更正：我不吃辣。', 'correct'],
    ['纠正一下，我其实是本科生。', 'correct'],
    ['纠正，我的专业是中文。', 'correct'],
    ['改过来，我不吃辣。', 'correct'],
    ['记反了，我不吃辣。', 'correct'],
    ['说错了，我不吃辣。', 'correct'],
  ]
  for (const [text, expected] of leading) {
    const intent = detectByRule(text)
    expect.equal(
      intent?.kind,
      expected,
      `「${text}」应判成 ${expected}（实际 ${String(intent?.kind)}）—— 更正被静默丢弃`
    )
  }
})

test('★ 负控（WP4 第 11 行：更正意图**误触发**）：引用 / 否定 / 假设 / 讨论这个词 ⇒ 不得判成显式意图', () => {
  /*
   * 用户对"未请求的认知干预"是**零容忍**的（ADR-055 §4）。这四条的共同点是"更正"这个词
   * **不在句首** ⇒ 由新规则的 `requiresLeading` 挡住（子串匹配会全部误命中）。
   */
  const mustStaySilent = [
    '你刚才说"更正"是什么意思？', // 引用
    '不用更正，就这样。', // 否定
    '如果我要更正的话会告诉你。', // 假设
    '我们讨论一下更正这件事。', // 讨论"更正"这个词本身
  ]
  for (const text of mustStaySilent) {
    const intent = detectByRule(text)
    expect.equal(intent, undefined, `「${text}」被误判成 ${String(intent?.kind)} —— 未请求的干预`)
  }
})

test('★ 边界（WP4 第 11 行）：改普通文本仍会命中**既有**的子串线索「改一下」', () => {
  /*
   * ⚠️ 如实登记一条边界：`D-55a` 只**追加**了一条句首规则，**没有**改动既有的子串线索
   *    （「之前那个改一下」不在句首，必须照旧命中）。于是"帮我把这段文字改一下"也会命中
   *    `correct`。
   *
   * 这一条**不是**"检测器必须沉默"的断言 —— 判据的落点是**"不得发生未经请求的记忆变更"**：
   *    目标解析不出来时，服务会如实 `target_not_found` 并**什么都不改**。
   *    那条断言属于 mutation 级的门（`pnpm m4:nl-mutation:verify`），不在这里假装它已经过了。
   */
  const intent = detectByRule('帮我把这段文字改一下。')
  expect.equal(intent?.kind, 'correct', '既有子串线索「改一下」照旧命中（本 ADR 明确不改它）')
})

test('"我记住了" 不算显式要求（命令式才要求句首命中）', () => {
  expect.equal(detectByRule('我记住了'), undefined)
  // 但"记住"在句首时算（宽容处理前两个字符的空白/标点）
  expect.equal(detectByRule('记住，我不吃香菜')?.kind, 'remember')
  expect.equal(detectByRule('嗯，记住我不吃香菜')?.kind, 'remember')
})

test('payload 只剥掉指令外壳，原样保留用户措辞', () => {
  const intent = detectByRule('记住，我技术问题更喜欢详细解释')
  expect.ok(intent !== undefined)
  expect.equal(intent!.payload, '我技术问题更喜欢详细解释')
  // 原句完整保留（它是证据的权威形式）
  expect.equal(intent!.sourceText, '记住，我技术问题更喜欢详细解释')
})

test('只有指令没有内容时 payload 为空（调用方需要区分"没意图"与"没说内容"）', () => {
  const intent = detectByRule('记住')
  expect.ok(intent !== undefined, '「记住」应当被识别为有意图')
  expect.equal(intent!.kind, 'remember')
  expect.equal(intent!.payload, '')
})

test('长关键词优先命中（"帮我记住" 不被 "记住" 抢先匹配）', () => {
  const intent = detectByRule('帮我记住我的学号是 12345')
  expect.ok(intent !== undefined)
  expect.equal(intent!.matched, '帮我记住')
  expect.equal(intent!.payload, '我的学号是 12345')
})

test('规则命中给出可复现的依据（进 trace 与审计）', () => {
  const intent = detectByRule('忘掉我关于香菜的偏好')
  expect.ok(intent !== undefined)
  expect.equal(intent!.detectedBy, 'rule')
  expect.equal(intent!.matched, '忘掉')
})

// ===========================================================================
// 18. 意图分类器端口（可注入，离线安全）
// ===========================================================================

group('意图分类器端口')

test('缺省分类器是"只规则"的那个（离线安全是缺省，不是选项）', async () => {
  const detector = createExplicitMemoryIntentDetector()
  expect.equal(detector.classifierName, 'rule-only')
  // 规则命中
  expect.equal((await detector.detect('记住我不吃香菜'))?.kind, 'remember')
  // 规则未命中 → 缺省分类器返回 undefined（不调模型）
  expect.equal(await detector.detect('我最近不太能喝奶了'), undefined)
})

test('注入的分类器只在规则未命中时被调用（计划书第 60 节"先走规则"）', async () => {
  let called = 0
  const detector = createExplicitMemoryIntentDetector({
    classifier: {
      name: 'spy',
      async classify(text) {
        called += 1
        return {
          kind: 'remember',
          payload: text,
          sourceText: text,
          detectedBy: 'classifier',
          matched: 'spy',
        }
      },
    },
  })

  // 规则命中 → 分类器**不该**被调用（否则每条消息都要多一次模型调用）
  const byRule = await detector.detect('记住我不吃香菜')
  expect.equal(byRule?.detectedBy, 'rule')
  expect.equal(called, 0, '规则命中时仍然调用了分类器')

  // 规则未命中 → 分类器被调用
  const byModel = await detector.detect('我最近不太能喝奶了')
  expect.equal(byModel?.detectedBy, 'classifier')
  expect.equal(called, 1)
})

test('分类器抛错 → 当作"没有显式意图"，不抛给调用方（显式路径失败不影响聊天）', async () => {
  /*
   * ⚠️ 这条必须测**真实的实现** `LlmMemoryIntentClassifier`，
   * 而不是一个只实现端口的 spy —— 因为"吞掉抛错"是那个类的职责。
   *
   * 实测踩到过：第一版这个类**漏了 try/catch**（注释里承诺了
   * "分类失败不影响聊天"，代码没做），而当时的测试用的是 spy，
   * 于是它测的是"spy 自己不抛"，永远绿。
   * 一个只测桩的测试会给出**假的绿色** —— 那比没有测试更糟。
   */
  const classifier = new LlmMemoryIntentClassifier({
    invokeModel: async () => {
      throw new Error('模型超时')
    },
  })
  // 直接测类：必须返回 undefined，而不是抛
  expect.equal(await classifier.classify('这句话规则认不出来'), undefined)

  // 经由检测器也要一样（规则未命中 → 走分类器 → 吞掉）
  const detector = createExplicitMemoryIntentDetector({ classifier })
  expect.equal(await detector.detect('这句话规则认不出来'), undefined)
})

test('分类器返回闭集外的词 → 没有意图（不猜最接近的）', async () => {
  const classifier = new LlmMemoryIntentClassifier({
    invokeModel: async () => 'gibberish-with-no-known-label',
  })
  expect.equal(await classifier.classify('随便一句话'), undefined)
})

test('分类器返回闭集内的词 → 识别出来，并标注依据为 classifier', async () => {
  const classifier = new LlmMemoryIntentClassifier({
    invokeModel: async () => 'remember',
  })
  const result = await classifier.classify('我最近不太能喝奶了')
  expect.equal(result?.kind, 'remember')
  expect.equal(result?.detectedBy, 'classifier')
})

test('语义写入分类器必须只接受完整闭集标签，不能从解释或否定句里截出操作', async () => {
  for (const raw of ['do not remember', 'remember or forget', 'I would remember this', '{"intent":"remember"}']) {
    const classifier = new LlmMemoryIntentClassifier({ invokeModel: async () => raw })
    expect.equal(await classifier.classify('请记住，我不吃香菜'), undefined, raw)
  }
})

test('显式意图只能来自用户事件（她的输出不可能被读成"用户要求记住"）', async () => {
  const detector = createExplicitMemoryIntentDetector()
  // 用户事件：正常
  const fromUser = await detectExplicitIntentFromEvent(detector, {
    id: 'cev:x:y:1' as never,
    actorType: 'user',
    content: '记住我不吃香菜',
  })
  expect.equal(fromUser?.kind, 'remember')

  // 角色事件：**必须抛错**（计划书第 148 节的污染链起点）
  let threw = false
  let code = ''
  try {
    await detectExplicitIntentFromEvent(detector, {
      id: 'cev:x:y:2' as never,
      actorType: 'character',
      content: '记住我不吃香菜',
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '她的输出被允许当成"用户要求记住"')
  expect.includes(code, 'explicit_intent_from_non_user')
})

// ===========================================================================
// 19. 内容抽取（规则优先）
// ===========================================================================

group('内容抽取（规则）')

test('常见显式记忆能落到已登记的槽位（中文线索词 → 英文 predicate）', async () => {
  const extractor = new RuleBasedContentExtractor()
  const cases: [string, string?][] = [
    ['我不吃香菜', 'food.preference.cilantro'],
    ['我特别喜欢香菜', 'food.preference.cilantro'],
    ['我现在是大学生', 'education.status'],
    ['我学的是计算机', 'education.major'],
    ['我技术问题喜欢详细解释', 'preferred.explanation.style'],
    ['简单说就行，我更喜欢简短一点', 'preferred.explanation.style'],
  ]
  for (const [text, expectedPredicate] of cases) {
    const result = await extractor.extract({
      text,
      owner: CHARACTER,
      speaker: USER,
    })
    expect.ok(result !== undefined, `「${text}」没被抽取出来`)
    if (expectedPredicate !== undefined) {
      expect.equal(result!.predicate, expectedPredicate, `「${text}」落到了 ${result!.predicate}`)
    }
    expect.ok(result!.basis.trim() !== '', '抽取结果必须带可解释的依据')
  }
})

test('⚠️ 回归（M6.1 WP5 产品发现②）：机构名的取值**不许**被线索词后面那一句的动词吃掉', async () => {
  /*
   * 实测过的真实缺陷（2026-09-24，冻结条文 `evals/m6.1/control/*.jsonl` 逐字）：
   *
   *   记住：我在江城大学读书。        ⇒ 落库值 **「书」**（应为「江城大学」）
   *   更正一下，我转学到明德大学了。  ⇒ 落库值 **「了」**（应为「明德大学」）
   *
   * 机制：`extractFreeTextValue` 的"往后"那一支把线索词之后的**下一句动词**当成了取值，
   * 再经 `normalizeValuePhrase` 剥掉前导系词表里的「读」⇒ 剩一个「书」。
   * 它不报错、长度也合理 ⇒ 只有"值内容对不对"能发现。
   */
  const extractor = new RuleBasedContentExtractor()
  const cases: [string, string][] = [
    ['记住：我在江城大学读书。', '江城大学'],
    ['更正一下，我转学到明德大学了。', '明德大学'],
    /* 既有断言（verify-m4-persistence）：不许回归 */
    ['记住：我在示例工程科技大学', '示例工程科技大学'],
    /* 取值在线索词**之后**（带系词）这一支也不许回归 */
    ['记住，我现在上的大学是示例工程科技大学', '示例工程科技大学'],
    /*
     * ⚠️ 这条守的是"**别把单字当边界**"：按"最后一个单字标记"切会把「上海」的「上」当边界，
     *    值会变成「海交通大学」。按**词组**匹配才不会。
     */
    ['记住：我在上海交通大学读书。', '上海交通大学'],
  ]
  for (const [text, expected] of cases) {
    const result = await extractor.extract({ text, owner: CHARACTER, speaker: USER })
    expect.ok(result !== undefined, `「${text}」没被抽取出来`)
    expect.equal(result!.predicate, 'education.institution', `「${text}」落到了 ${result!.predicate}`)
    expect.equal(
      String((result!.content as { value?: unknown }).value),
      expected,
      `「${text}」的取值被抽成了别的`
    )
  }
})

test('规则抽取结果里带**规则版本**（否则"这条值是哪一版规则抽的"无法回答）', async () => {
  const extractor = new RuleBasedContentExtractor()
  const result = await extractor.extract({
    text: '记住：我在江城大学读书。',
    owner: CHARACTER,
    speaker: USER,
  })
  expect.ok(result !== undefined)
  expect.ok(
    result!.basis.includes(CONTENT_RULE_VERSION),
    `basis 里没有规则版本：${result!.basis}`
  )
})

test('否定线索决定取值（"不吃香菜" 是 dislike，不是 like）', async () => {
  const extractor = new RuleBasedContentExtractor()
  const dislike = await extractor.extract({
    text: '我不吃香菜',
    owner: CHARACTER,
    speaker: USER,
  })
  expect.equal((dislike!.content as { value: unknown }).value, 'dislike')

  const like = await extractor.extract({
    text: '我很喜欢香菜',
    owner: CHARACTER,
    speaker: USER,
  })
  expect.equal((like!.content as { value: unknown }).value, 'like')
})

test('解析不出来时返回 undefined，**不猜**（丢事实与猜错是两件事，前者可接受）', async () => {
  const extractor = new RuleBasedContentExtractor()
  const unresolved = await extractor.extract({
    text: '我最近不太能喝奶了',
    owner: CHARACTER,
    speaker: USER,
  })
  expect.equal(unresolved, undefined, '规则声称解析出了一条它其实没有把握的记忆')
})

test('抽取出的槽位都是**已登记**的键（否则它会一直是"未登记"计数）', async () => {
  const extractor = new RuleBasedContentExtractor()
  const probes = [
    '我不吃香菜',
    '我现在是大学生',
    '我学的是计算机',
    '我技术问题喜欢详细解释',
  ]
  for (const text of probes) {
    const result = await extractor.extract({ text, owner: CHARACTER, speaker: USER })
    if (result?.predicate === undefined) continue
    expect.ok(
      isRegisteredPredicate(result.predicate),
      `抽取器产出的 ${result.predicate} 不在登记表里`
    )
  }
})

test('空链的抽取器必须抛错（空链会让每条显式记忆都"解析不出来"）', () => {
  let threw = false
  try {
    new ChainedContentExtractor([])
  } catch (error) {
    threw = String((error as { code?: string }).code).includes('empty_extractor_chain')
  }
  expect.ok(threw)
})

test('链式抽取器：先规则，规则未命中才问下一个', async () => {
  let secondCalled = 0
  const chained = new ChainedContentExtractor([
    new RuleBasedContentExtractor(),
    {
      name: 'spy-second',
      async extract(input) {
        secondCalled += 1
        return {
          type: 'person_fact' as const,
          content: { kind: 'claim' as const, subject: input.speaker, predicate: 'spy.slot', value: 'x' },
          subjects: [input.speaker],
          confidence: 0.5,
          basis: 'spy',
        }
      },
    },
  ])

  // 规则命中 → 第二个不该被调用
  await chained.extract({ text: '我不吃香菜', owner: CHARACTER, speaker: USER })
  expect.equal(secondCalled, 0, '规则命中时仍调用了链上的下一个抽取器')

  // 规则未命中 → 第二个被调用
  await chained.extract({ text: '我最近不太能喝奶了', owner: CHARACTER, speaker: USER })
  expect.equal(secondCalled, 1)
})

// ===========================================================================
// 20. 目标打分（纯函数）
// ===========================================================================

group('目标打分（第 4 步：只在收窄过的集合里打分）')

test('predicate 末段命中线索词时得分最高', () => {
  const cilantroRec = record('preference', claim())
  const educationRec = record('person_fact', claim({ predicate: 'education.status', value: 'undergraduate' }))

  const scored = scoreByHints([cilantroRec, educationRec], ['cilantro'], '')
  expect.equal(scored.length, 1, '打分没有把更相关的那条区分出来')
  expect.equal(String(scored[0].id), String(cilantroRec.id))
})

test('**一条都没打上分时返回全部候选**（让上层报 ambiguous，而不是报 not_found）', () => {
  /*
   * 这个区分很关键：
   *   · 返回 [] → 上层读成 not_found → 用户听到"我找不到这条记忆"
   *   · 返回全部 → 上层读成 ambiguous → 用户听到"你说的是哪一条？"
   *
   * 而中文"香菜"与 predicate `food.preference.cilantro` 没有词面重叠，
   * 因此这是**最常见**的那条路径（见 target-resolver.ts 的说明）。
   * 报 ambiguous 是诚实的；报 not_found 会让用户以为记忆丢了。
   */
  const a = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'dislike' }))
  const b = record('person_fact', claim({ predicate: 'education.status', value: 'undergraduate' }))
  const scored = scoreByHints([a, b], ['香菜'], '忘掉香菜')
  expect.equal(scored.length, 2, '没打上分时应当返回全部候选，让上层报歧义')
})

test('并列最高分都被保留（不因为排序把并列的丢掉一条）', () => {
  const a = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'dislike' }))
  const b = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'like' }))
  const scored = scoreByHints([a, b], ['cilantro'], '')
  expect.equal(scored.length, 2)
})

// ===========================================================================
// 21. 语义判别器（计划书第 57 节的第 5 级）
// ===========================================================================

group('语义判别器')

test('parseChoiceIndex：模型只能给候选集内的编号', () => {
  expect.equal(parseChoiceIndex('1', 3), 0)
  expect.equal(parseChoiceIndex('3', 3), 2)
  expect.equal(parseChoiceIndex('第 3 条', 3), 2)
  expect.equal(parseChoiceIndex('答案是 2。', 3), 1)
  // 越界 / 0 / 无数字 / 负数 → 全是"判不出来"
  expect.equal(parseChoiceIndex('4', 3), undefined)
  expect.equal(parseChoiceIndex('0', 3), undefined)
  expect.equal(parseChoiceIndex('我不知道', 3), undefined)
  expect.equal(parseChoiceIndex('-1', 3), undefined)
  expect.equal(parseChoiceIndex('', 3), undefined)
})

test('LlmSemanticJudge：模型超时 → 判不出来（不抛给调用方）', async () => {
  const judge = new LlmSemanticJudge({
    invokeModel: async () => {
      throw new Error('模型超时')
    },
  })
  const result = await judge.choose({ text: '忘掉那个', candidates: [record('preference', claim())] })
  expect.equal(result, undefined)
})

test('LlmSemanticJudge：模型越界编号 → 判不出来（不接受候选集外的 id）', async () => {
  const judge = new LlmSemanticJudge({ invokeModel: async () => '99' })
  const result = await judge.choose({ text: 'x', candidates: [record('preference', claim())] })
  expect.equal(result, undefined)
})

test('LlmSemanticJudge：合法编号 → 返回对应的那条', async () => {
  const a = record('preference', claim())
  const b = record('person_fact', claim({ predicate: 'education.status', value: 'undergraduate' }))
  const judge = new LlmSemanticJudge({ invokeModel: async () => '2' })
  const result = await judge.choose({ text: '上大学', candidates: [a, b] })
  expect.equal(String(result?.memoryId), String(b.id))
})

test('LexicalSemanticJudge：唯一词面命中 → 选中；零命中 / 多命中 → 判不出来', async () => {
  const judge = new LexicalSemanticJudge()
  const institutionRec = record(
    'person_fact',
    claim({ predicate: 'education.institution', value: '示例工程科技大学' })
  )
  const statusRec = record(
    'person_fact',
    claim({ predicate: 'education.status', value: 'undergraduate' })
  )

  /*
   * ⚠️ **M9.5 / `D-5`（`ADR-084`）**：片段粒度 **2 字 → 3 字** 之后，
   *    "共享 `大学` 这个 **2 字**片段"**不再构成命中** ✗ ⇒ 这条测试的**意图**（唯一命中 ⇒ 选中）
   *    仍然正确，只是**夹具过时了** ✓
   * ⇒ 把**查询**换成与 institution 取值共享 **3 字**片段的说法（`西安电`/`安电子`/…/`技大学`）
   *    ⇒ 意图重新成立 ✓（⚠️ **不是**把期望改掉 —— 期望是对的 ✓）
   */
  const one = await judge.choose({
    text: '忘掉我示例工程科技大学这件事',
    candidates: [institutionRec],
  })
  expect.equal(String(one?.memoryId), String(institutionRec.id))

  // 两条都命中 → 判不出来（**不挑第一条**）
  const both = await judge.choose({
    text: '忘掉我示例工程科技大学这件事',
    candidates: [institutionRec, statusRec],
  })
  // status 的槽位名里没有这些片段、取值 undergraduate 也没有 → 只有 institution 命中
  expect.equal(String(both?.memoryId), String(institutionRec.id))

  // 完全无重叠 → 判不出来
  const none = await judge.choose({ text: '忘掉那件事', candidates: [institutionRec, statusRec] })
  expect.equal(none, undefined)
})

// ===========================================================================
// 22. 目标解析的优先顺序（计划书第 57 节）
// ===========================================================================

group('目标解析（第 1–5 步的顺序）')

/** 造一个内存版解析器依赖，用来逐级验证顺序（不碰数据库） */
function makeResolverDeps(records: MemoryRecord[], options: { judge?: SemanticJudgePort } = {}) {
  return {
    get: async (id: string) => records.find((r) => String(r.id) === String(id)) ?? null,
    getActiveByCanonicalKey: async (key: string) =>
      records.filter((r) => r.canonicalKey === key && r.status === 'active'),
    listBySubject: async () => records.filter((r) => r.status === 'active'),
    ...(options.judge !== undefined ? { semanticJudge: options.judge } : {}),
  }
}

test('第 1 步：显式 id 直接命中（0 次模糊匹配）', async () => {
  const target = record('preference', claim())
  const resolver = createTargetMemoryResolver(makeResolverDeps([target]) as never)
  const result = await resolver.resolve({ owner: CHARACTER, text: '', explicitId: target.id })
  expect.equal(result.status, 'resolved')
  expect.equal(result.status === 'resolved' ? result.via : '', 'explicit_id')
})

test('第 1 步：显式 id **找不到**时不继续猜（返回 not_found 而不是往下走）', async () => {
  const target = record('preference', claim())
  const resolver = createTargetMemoryResolver(makeResolverDeps([target]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉它',
    explicitId: 'mem:char_sumuwei:does-not-exist' as never,
    subject: USER,
  })
  expect.equal(result.status, 'not_found')
  expect.equal(result.status === 'not_found' ? result.via : '', 'explicit_id')
})

test('第 1 步：显式 id 属于别的 owner → 抛错（不是"没找到"）', async () => {
  const otherOwnerRecord = {
    ...record('preference', claim()),
    owner: entityRef('character', 'char_someone_else'),
  }
  const resolver = createTargetMemoryResolver(makeResolverDeps([otherOwnerRecord]) as never)
  let threw = false
  let code = ''
  try {
    await resolver.resolve({
      owner: CHARACTER,
      text: '',
      explicitId: otherOwnerRecord.id,
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '别人的记忆被允许当成本次操作的目标（Memory Space 隔离被破坏）')
  expect.includes(code, 'target_owner_mismatch')
})

test('第 2 步：canonical key 唯一命中', async () => {
  const target = record('preference', claim())
  const resolver = createTargetMemoryResolver(makeResolverDeps([target]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '',
    canonicalKey: target.canonicalKey,
  })
  expect.equal(result.status, 'resolved')
  expect.equal(result.status === 'resolved' ? result.via : '', 'canonical_key')
})

test('第 2 步：同一槽位多条 ACTIVE → 报 ambiguous（那本身是健康问题，要被看见）', async () => {
  const a = record('preference', claim())
  const b = record('preference', claim()) // 同一槽位、同一内容 → 同一 key
  const resolver = createTargetMemoryResolver(makeResolverDeps([a, b]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '',
    canonicalKey: a.canonicalKey,
  })
  expect.equal(result.status, 'ambiguous')
})

test('第 5 步：判别器判得出来 → resolved / via = model_resolver', async () => {
  /*
   * ⚠️ M4.1：夹具改过，理由必须记下来（改既有测试永远是可疑动作）。
   *
   * 原夹具：target = `education.status`/`undergraduate`，other = 默认 preference，
   *         text = "忘掉我上大学这件事"。
   * 当时第 5 步对**全部** active 候选开放，所以这条测的是
   * "判别器被咨询时，它的选择被采纳"。
   *
   * M4.1 之后第 5 步**只在相关性已收窄到 ≥2 条之后**才开放（这正是 D1 的修复点）。
   * 原夹具那两条候选与那句话**都没有词面重叠** → 现在会正确地走 not_found，
   * 判别器**不该**被问。
   *
   * 因此夹具改成"两条都与『大学』词面相关"，而测试的意图**完全不变**：
   * 仍然验证 via = model_resolver。变的是进入这一步的前置条件。
   *
   * ⚠️ **M9.5 / `D-5`（`ADR-084`）再改一次，理由同上**：片段粒度 **2 字 → 3 字** ⇒
   *    "共享 `大学`（2 字）"**不再构成命中** ✗ ⇒ 前置条件又坏了 ⇒
   *    夹具改为**两条都与查询共享一个 3 字片段**（`上大学`）⇒ 意图重新成立 ✓
   *    ⚠️ **两条都要共享** —— 第 5 步只在"相关性已收窄到 ≥2 条"时开放 ✓
   */
  const target = record(
    'person_fact',
    claim({ predicate: 'education.institution', value: '上大学·示例工程科技大学' })
  )
  const other = record('person_fact', claim({ predicate: 'education.status', value: '上大学四年级' }))
  const resolver = createTargetMemoryResolver(
    makeResolverDeps([target, other], {
      judge: {
        name: 'always-picks-target',
        async choose() {
          return { memoryId: target.id, reason: '测试桩明确选中' }
        },
      },
    }) as never
  )
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我上大学这件事',
    subject: USER,
  })
  expect.equal(result.status, 'resolved')
  expect.equal(result.status === 'resolved' ? result.via : '', 'model_resolver')
})

test('第 5 步：判别器判不出来 → ambiguous（**不挑一条**）', async () => {
  // M4.1：同上游那条 —— 夹具改成"两条都与『大学』词面相关"，
  // 否则判别器不该被问（现在的第 5 步只在相关性收窄后才开放）。
  /*
   * ⚠️ **M9.5 / `D-5`（`ADR-084`）**：与上游那条同因 —— 片段 **2 字 → 3 字** 之后，
   *    "共享 `大学`（2 字）"**不再构成命中** ✗ ⇒ 第 5 步不开放 ⇒ 判别器不被问 ⇒ 断言失败 ✓
   * ⇒ 夹具改为**两条都与查询共享 3 字片段 `上大学`**（两条都要 —— 第 5 步要求 ≥2 条 ✓）
   *    ⇒ 判别器**被问**、桩返回 `undefined` ⇒ 结果应为 **`ambiguous`（不挑一条）** ✓
   */
  const target = record(
    'person_fact',
    claim({ predicate: 'education.institution', value: '上大学·示例工程科技大学' })
  )
  const other = record('person_fact', claim({ predicate: 'education.status', value: '上大学四年级' }))
  const resolver = createTargetMemoryResolver(
    makeResolverDeps([target, other], {
      judge: { name: 'always-unsure', async choose() { return undefined } },
    }) as never
  )
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我上大学这件事',
    subject: USER,
  })
  expect.equal(result.status, 'ambiguous')
})

test('判别器返回候选集外的 id → **抛错**（不接受它凭空决定一条记忆）', async () => {
  // M4.1：同上游两条 —— 夹具改成"两条都与『大学』词面相关"，
  // 否则判别器不该被问，这条测的就成了"一个从未发生的调用"。
  /*
   * ⚠️ **M9.5 / `D-5`（`ADR-084`）**：片段粒度 **2 字 → 3 字** 之后，
   *    "共享 `大学` 这个 **2 字**片段"**不再构成命中** ✗ ⇒ 判别器不会被问 ⇒
   *    这条**安全性质**（"凭空返回域外 id 必须抛错"）就**失去了覆盖** ✗✗
   * ⇒ 夹具改为**共享一个 3 字片段**（`上大学`）⇒ 判别器**重新被问** ⇒ 性质**重新被触达** ✓
   * ⚠️ **不许**删掉这条断言了事 —— 它测的是一条真的安全性质 ✓
   */
  const target = record(
    'person_fact',
    claim({ predicate: 'education.institution', value: '上大学这件事' })
  )
  const other = record('person_fact', claim({ predicate: 'education.status', value: '上大学四年级' }))
  const resolver = createTargetMemoryResolver(
    makeResolverDeps([target, other], {
      judge: {
        name: 'hallucinating-judge',
        async choose() {
          return { memoryId: 'mem:char_sumuwei:invented' as never, reason: '编了一条' }
        },
      },
    }) as never
  )
  let threw = false
  let code = ''
  try {
    await resolver.resolve({ owner: CHARACTER, text: '忘掉我上大学这件事', subject: USER })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '判别器返回了候选集外的 id 却被接受 —— 它可以凭空决定一条记忆')
  expect.includes(code, 'semantic_judge_out_of_candidates')
})

// ===========================================================================
// 22b. M4.1 — 目标相关性闸（D1 的单元级回归）
// ===========================================================================

group('目标相关性闸（M4.1 / D1 回归）')

/*
 * ===========================================================================
 *  这一组守的是什么
 * ===========================================================================
 * D1 的根因是一行看起来完全合理的捷径：
 *
 *     if (active.length === 1) return resolved
 *
 * 它把"**唯一**"当成了"**相关**"。因此这里的每一条都在问同一件事：
 *
 *     候选数，到底参与了判定没有？
 *
 * 判据刻意做成"**候选数变了，结论不变**"：
 *   · 同样一句无关的话，库里 1 条候选和 2 条候选都必须是 not_found
 *   · 同样一句相关的话，1 条候选必须是 resolved
 */

/** 造一条 claim 记录（沿用本文件既有的 record/claim 夹具） */
function rec(predicate: string, value: string) {
  return record('person_fact', claim({ predicate, value }))
}

const EXAMPLE_UNIVERSITY = rec('education.institution', '示例工程科技大学')

test('T-D1-001 单条无关候选 + 「忘掉鹦鹉」→ not_found（**不看候选数**）', async () => {
  const resolver = createTargetMemoryResolver(makeResolverDeps([EXAMPLE_UNIVERSITY]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我养过一只鹦鹉这件事',
    subject: USER,
  })
  expect.equal(result.status, 'not_found')
  expect.notOk(
    result.status === 'resolved' && String(result.record.id) === String(EXAMPLE_UNIVERSITY.id),
    '无关的单条候选被当成了命中 —— 这正是 D1'
  )
})

test('T-D1-002 单条无关候选 + 「忘掉 VS Code」→ not_found', async () => {
  const resolver = createTargetMemoryResolver(makeResolverDeps([EXAMPLE_UNIVERSITY]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我用 VS Code 这件事',
    subject: USER,
  })
  expect.equal(result.status, 'not_found')
})

test('T-D1-003 单条**相关**候选 → resolved / relevance_match / strong', async () => {
  const resolver = createTargetMemoryResolver(makeResolverDeps([EXAMPLE_UNIVERSITY]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我在示例工程科技大学上学这件事',
    subject: USER,
  })
  expect.equal(result.status, 'resolved')
  expect.equal(result.status === 'resolved' ? result.via : '', 'relevance_match')
  expect.equal(result.status === 'resolved' ? result.confidence : '', 'strong')
  expect.equal(result.status === 'resolved' ? String(result.record.id) : '', String(EXAMPLE_UNIVERSITY.id))
})

test('T-D1-005 两条候选都与请求无关 → not_found（候选数 2 也不猜）', async () => {
  const other = rec('project.background.active', 'Rust')
  const resolver = createTargetMemoryResolver(makeResolverDeps([EXAMPLE_UNIVERSITY, other]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我养过一只鹦鹉这件事',
    subject: USER,
  })
  expect.equal(result.status, 'not_found')
})

test('Mutation Gate：mayMutate 只对 exact / strong 放行', () => {
  expect.ok(
    mayMutate({ status: 'resolved', record: EXAMPLE_UNIVERSITY, via: 'explicit_id', candidates: 1, confidence: 'exact' })
  )
  expect.ok(
    mayMutate({
      status: 'resolved',
      record: EXAMPLE_UNIVERSITY,
      via: 'relevance_match',
      candidates: 1,
      confidence: 'strong',
    })
  )
  // weak / none 一律不放行 —— 今天没有生产者，但闸必须对它们关闭
  expect.notOk(
    mayMutate({ status: 'resolved', record: EXAMPLE_UNIVERSITY, via: 'hint_scoring', candidates: 1, confidence: 'weak' })
  )
  expect.notOk(
    mayMutate({ status: 'resolved', record: EXAMPLE_UNIVERSITY, via: 'hint_scoring', candidates: 1, confidence: 'none' })
  )
  expect.notOk(mayMutate({ status: 'ambiguous', candidates: [EXAMPLE_UNIVERSITY], via: 'hint_scoring' }))
  expect.notOk(mayMutate({ status: 'not_found', via: 'subject_predicate', triedPaths: [] }))
})

test('T-D1-008 中文说法经**登记表**命中槽位（香菜 → food.preference.cilantro）', async () => {
  /*
   * ===========================================================================
   *  这一条补的是 Layer D 抓到的一个真实缺口
   * ===========================================================================
   * 第一版的相关性闸只拿 `predicate + value` 当 haystack，于是：
   *
   *     用户说「忘掉我不吃香菜这件事」
   *     记录是 `food.preference.cilantro = dislike`
   *     → haystack 里**没有"香菜"**（它在英文键与登记表的中文说明里）
   *     → 判成零命中 → not_found → **用户明确要求忘掉的那条，系统说找不到**
   *
   * 当时离线的 A/B/C 三层**全绿** —— 因为它们的夹具恰好都是
   * "值里含中文"的形状（示例工程科技大学 / VS Code）。
   * 抓到它的是 `m4:smoke:live`（真实多轮）。
   *
   * 修法：把登记项的 `description` 与 `examples` 算进 haystack ——
   * 本项目自己的教条是"同义词归并的正确位置是登记表"。
   *
   * 这条用例把它钉在**离线**：以后同类缺口不必再等真实冒烟。
   */
  const cilantro = record(
    'preference',
    claim({ predicate: 'food.preference.cilantro', value: 'dislike' })
  )
  const resolver = createTargetMemoryResolver(makeResolverDeps([cilantro]) as never)
  const result = await resolver.resolve({
    owner: CHARACTER,
    text: '忘掉我不吃香菜这件事',
    subject: USER,
  })
  expect.equal(result.status, 'resolved')
  expect.equal(result.status === 'resolved' ? String(result.record.id) : '', String(cilantro.id))
})

test('拉丁片段用**整段**而不是 bigram（否则 od ⊂ food 会假命中）', () => {
  /*
   * 这一条锁的是 M4.1 自己引入的判据，理由：
   *
   * 若把拉丁字母也切成 bigram，"Code" 会产出 `co` / `od` / `de`，
   * 而 `od` 出现在 `food` 里 —— 于是"忘掉我用 Code"会命中一条 food 记忆，
   * 而那是**和 D1 同形的错**：词面片段太短，相关性证据就不成立。
   */
  const food = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'dislike' }))
  const fragments = lexicalFragments('忘掉我用 Code')
  expect.notOk(fragments.includes('od'), `片段里不该出现 "od"：${fragments.join(',')}`)
  expect.equal(lexicalOverlapHits('忘掉我用 Code', [food]).length, 0)

  // 正向：真实相关的拉丁词仍然命中（整段匹配）
  const editor = record('preference', claim({ predicate: 'tooling.preference.editor', value: 'VS Code' }))
  expect.equal(lexicalOverlapHits('忘掉我用 VS Code', [editor]).length, 1)
})

// ===========================================================================
// 21c. correct 目标层兜底（M6.1 WP5 / B① / ADR-058）—— 纯函数回归锁
// ===========================================================================

group('correct 目标层兜底（B① / ADR-058）')

/*
 * 这一组锁的是 ADR-058 的两个纯函数（`correction-fallback.ts`）：
 *   · `pickRecentExplicitWriteTarget` —— "会话内最近一次显式写入"的确定性选靶
 *   · `extractCorrectionValue` —— 槽位限定的取值 + 四道守卫
 * 服务层/落库层的正负控在 `pnpm m6.1:update-turn:service-repro`（隔离库）；
 * 这里只锁**判据本身**（离线、秒级、每次改这一片都能跑）。
 */

test('选靶：0 候选 ⇒ undefined（维持 not_found）；单槽位 ⇒ 最近在前的那条', () => {
  expect.equal(pickRecentExplicitWriteTarget([]), undefined)

  const major = record('person_fact', claim({ predicate: 'education.major', value: '汉语言文学' }))
  const targeted = pickRecentExplicitWriteTarget([major]) as
    | { status: 'targeted'; record: MemoryRecord; slot: string }
    | undefined
  expect.ok(targeted !== undefined && targeted.status === 'targeted', '单槽位必须给出确定目标')
  expect.equal(String(targeted?.record.id), String(major.id))
  expect.equal(targeted?.slot, 'education.major')
})

test('选靶：≥2 个不同槽位 ⇒ ambiguous（绝不挑一条）；同槽位多条 ⇒ 取最近', () => {
  const major = record('person_fact', claim({ predicate: 'education.major', value: '汉语言文学' }))
  const device = record('person_fact', claim({ predicate: 'device.primary', value: 'Windows 笔记本' }))
  const mixed = pickRecentExplicitWriteTarget([device, major]) as
    | { status: 'ambiguous'; slots: string[] }
    | undefined
  expect.ok(mixed !== undefined && mixed.status === 'ambiguous', '两个槽位必须报歧义，而不是挑一条')
  expect.equal(mixed?.slots.length, 2)

  // 端口契约是"最近在前"：同一槽位的两条（supersede 链残留）取第一条
  const older = record('person_fact', claim({ predicate: 'education.major', value: '汉语言文学' }))
  const newer = record('person_fact', claim({ predicate: 'education.major', value: '历史学' }))
  const single = pickRecentExplicitWriteTarget([newer, older]) as
    | { status: 'targeted'; record: MemoryRecord }
    | undefined
  expect.ok(single !== undefined && single.status === 'targeted')
  expect.equal(String(single?.record.id), String(newer.id))
})

test('选靶：superseded / 无槽位的候选不参与（只数"现在的值"）', () => {
  const major = record('person_fact', claim({ predicate: 'education.major', value: '汉语言文学' }))
  const gone = {
    ...record('person_fact', claim({ predicate: 'device.primary', value: 'Windows 笔记本' })),
    status: 'superseded' as const,
  }
  // superseded 的 device 不算数 ⇒ 只剩 major 一个槽位 ⇒ targeted（而不是 ambiguous）
  const target = pickRecentExplicitWriteTarget([gone, major]) as
    | { status: 'targeted'; record: MemoryRecord }
    | undefined
  expect.ok(target !== undefined && target.status === 'targeted')
  expect.equal(String(target?.record.id), String(major.id))
})

test('取值：转换标记 + 同小句取值 + 剥句末「了」（冻结两条 SRP-C-04/C-09 的形状）', () => {
  const device = record('person_fact', claim({ predicate: 'device.primary', value: 'Windows 笔记本' }))
  const major = record('person_fact', claim({ predicate: 'education.major', value: '汉语言文学' }))
  expect.equal(extractCorrectionValue('我换成 Mac 了。', device)?.value, 'Mac')
  expect.equal(extractCorrectionValue('我转到历史学了。', major)?.value, '历史学')
  // 取值只取同一个小句：后面的小句不混进来
  expect.equal(extractCorrectionValue('我换成 Mac 了，屏幕也换了。', device)?.value, 'Mac')
  // basis 只含标记与槽位 + 版本，不含取值正文（计划书第 110 节：内容不进 trace）
  const basis = extractCorrectionValue('我换成 Mac 了。', device)?.basis ?? ''
  expect.notOk(basis.includes('Mac'), `basis 不得含取值正文：${basis}`)
  expect.ok(basis.includes('device.primary'), 'basis 应含槽位（可审计）')
  expect.ok(basis.includes(CORRECTION_FALLBACK_VERSION), 'basis 应带兜底规则版本')
  expect.equal(CORRECTION_FALLBACK_VERSION, 'correction-fallback@2')
})

test('B② 槽位限定抽取闸：恰好目标槽位的 claim ⇒ 采用（冻结 SRP-C-05 的形状）', () => {
  const status = record('person_fact', claim({ predicate: 'education.status', value: 'undergraduate' }))
  /*
   * 实测缺口（候选 59493d58e9ef 四轮引文级留痕）：「更正一下，我读研究生了。」
   * 无转换标记 ⇒ B① 四道守卫全过不了 ⇒ 四轮全不落（活体记忆永远只有旧值）。
   * B②：抽取器对「研究生」有 education.status=graduate 规则 ⇒ 槽位恰好匹配 ⇒ 接住。
   */
  const graduate = slotRestrictedCorrectionValue(
    {
      type: 'person_fact',
      content: claim({ predicate: 'education.status', value: 'graduate' }),
      subjects: [],
      confidence: 0.8,
      basis: 'content-rules@2',
      predicate: 'education.status',
    },
    status
  )
  expect.equal(graduate?.value, 'graduate')
  expect.ok(String(graduate?.basis).includes('B②'), 'basis 应标 B② 路径')
  expect.ok(String(graduate?.basis).includes('education.status'), 'basis 应含槽位（可审计）')
  expect.notOk(String(graduate?.basis).includes('graduate'), 'basis 不得含取值正文（计划书第 110 节）')
})

test('B② 负控：undefined / episode / 槽位不匹配 / 空值 ⇒ 一律拒绝（不猜、不写）', () => {
  const status = record('person_fact', claim({ predicate: 'education.status', value: 'undergraduate' }))
  // 抽取器没抽出东西（「我把闹钟换成七点了」对任何槽位都无规则）⇒ 拒绝
  expect.equal(slotRestrictedCorrectionValue(undefined, status), undefined)
  // episode 无值可言 ⇒ 拒绝（防御）
  expect.equal(
    slotRestrictedCorrectionValue(
      { type: 'episode', content: episode(), subjects: [], confidence: 0.8, basis: 'x' },
      status
    ),
    undefined
  )
  // 抽出来的是**别的槽位**（device.primary）⇒ 这句话不在说目标 ⇒ 拒绝
  expect.equal(
    slotRestrictedCorrectionValue(
      {
        type: 'person_fact',
        content: claim({ predicate: 'device.primary', value: 'Mac' }),
        subjects: [],
        confidence: 0.8,
        basis: 'content-rules@2',
        predicate: 'device.primary',
      },
      status
    ),
    undefined
  )
  // 值为空 ⇒ 拒绝
  expect.equal(
    slotRestrictedCorrectionValue(
      {
        type: 'person_fact',
        content: claim({ predicate: 'education.status', value: '' }),
        subjects: [],
        confidence: 0.8,
        basis: 'content-rules@2',
        predicate: 'education.status',
      },
      status
    ),
    undefined
  )
})

test('取值守卫③：指代/量词开头 ⇒ 拒绝（不猜、不写）', () => {
  const device = record('person_fact', claim({ predicate: 'device.primary', value: 'Windows 笔记本' }))
  for (const text of ['我换成另一首了。', '我换成这台了。', '我换成同一个了。', '我换成几台了。']) {
    expect.equal(
      extractCorrectionValue(text, device),
      undefined,
      `「${text}」应被指代/量词前缀守卫拒绝`
    )
  }
  // 无标记 / 空句 ⇒ 拒绝（「换个」不是「换成」—— 闭集就是闭集）
  expect.equal(extractCorrectionValue('我换了个新的。', device), undefined)
  expect.equal(extractCorrectionValue('', device), undefined)
})

test('取值守卫④：把字句对象与目标槽位词面无关 ⇒ 拒绝（误伤面的主闸）', () => {
  const device = record('person_fact', claim({ predicate: 'device.primary', value: 'Windows 笔记本' }))
  /*
   * 「七点」本身过得了 ①②③ —— 挡住它的是"这句话在说**闹钟**"。
   * 这正是 ADR-058 §3 neg-alarm-prior 的判据（负控在服务层复现器里跑，
   * 这里锁纯函数本身）。
   */
  expect.equal(extractCorrectionValue('我把闹钟换成七点了。', device), undefined)
  expect.equal(extractCorrectionValue('我把这首歌换成另一首了。', device), undefined)
  /*
   * ⚠️ 如实登记的**漏而不误**面：「电脑」不在 device.primary 的登记表说法里
   * （登记表写的是「常用设备」）⇒ 会被本守卫拒绝。宁可漏（她如实说没找到），
   * 不可误（把闹钟的七点写进设备槽位）。
   */
  expect.equal(extractCorrectionValue('我把电脑改成 Mac 了。', device), undefined)
  // 正向：对象 = 旧值（词面相关）⇒ 接受
  expect.equal(extractCorrectionValue('我把 Windows 换成 Mac 了。', device)?.value, 'Mac')
  // 「把」在另一个小句 ⇒ 不是被换的对象，不施加该守卫
  expect.equal(extractCorrectionValue('我先把手机放下了，后来换成 Mac 了。', device)?.value, 'Mac')
})

test('取值守卫②：超过 60 字 ⇒ 拒绝（与抽取器同界）', () => {
  const device = record('person_fact', claim({ predicate: 'device.primary', value: 'Windows 笔记本' }))
  expect.equal(extractCorrectionValue(`我换成${'X'.repeat(61)}了。`, device), undefined)
  expect.equal(extractCorrectionValue(`我换成${'X'.repeat(60)}了。`, device)?.value, 'X'.repeat(60))
})



// ===========================================================================
// 22c. M4.1 — 执行真相（Response Truth / INV-M41-03）
// ===========================================================================

group('执行真相（Response Truth / INV-M41-03）')

/*
 * ===========================================================================
 *  这一组为什么必须是**纯函数**测试
 * ===========================================================================
 * C7（`content_unresolved` 不再产生成功口吻）是 Hard Gate。
 * 而"模型会不会听话"**测不了** —— 它每次都不一样。
 *
 * 所以判据被做成一个纯函数：`applyResponseTruthPolicy()`。
 * 它不读时间、不读环境、不写任何东西，因此每一条分支都能被离线钉死；
 * 而"她实际说了什么"由 Layer D 的 production-copy smoke 断言
 * （那里测的是端到端一致性）。
 */

function notWritten(reason: string): ExplicitMemoryTurnResult {
  return { kind: 'not_written', intent: 'remember', reason, summary: '（略）' }
}
function written(): ExplicitMemoryTurnResult {
  return { kind: 'written', intent: 'remember', memoryId: 'mem:x', summary: '（略）' }
}
function alreadyApplied(): ExplicitMemoryTurnResult {
  return { kind: 'already_applied', intent: 'remember', summary: '（略）' }
}

test('C7：未写入 + 「记住了」→ **必须被替换**，且 executed=false', () => {
  const out = applyResponseTruthPolicy({
    result: notWritten('content_unresolved'),
    replyText: '行，记住了。',
  })
  expect.ok(out.corrected, '未执行却保留了成功口吻 —— C7 失败')
  expect.equal(out.executed, false)
  expect.notOk(
    replyClaimsSuccess(out.replyText).claims,
    `替换后的句子自己就带成功口吻：${out.replyText}`
  )
})

test('C7 反面：未写入 + **已被否定**的表述 → 不得替换（"我没记住"是如实的）', () => {
  const out = applyResponseTruthPolicy({
    result: notWritten('content_unresolved'),
    replyText: '我没记住，这句话我没能拆出来。',
  })
  expect.notOk(out.corrected, `如实表述被误改成：${out.replyText}`)
  expect.equal(out.executed, false)
})

test('C7：未写入 + 与记忆无关的回复 → 不替换（不误伤普通对话）', () => {
  const out = applyResponseTruthPolicy({
    result: notWritten('target_not_found'),
    replyText: '今天天气不错，要不要出去走走？',
  })
  expect.notOk(out.corrected)
})

/*
 * ============================================================================
 *  ★ A2（2026-10-10）三段式：**"这一轮不归记忆域管"时不得替换**
 * ============================================================================
 *  真机事故：她把「什么意思？」答成 `收到，记忆请求会在这轮回复后处理；现在还没有完成。`
 *  根因：`post_turn_model` 模式下 `pending_post_turn` 是**每一轮**都有的常量
 *  （`post-turn-model-memory.ts:47` 逐字 "No classification or model call before the reply"），
 *  于是替换只看**她自己措辞**里有没有"记住了/我记着" ⇒ 与记忆无关的语境也整轮被顶掉。
 *
 *  ⚠️ 判据落在**程序事实** `userAskedToRemember` 上（由纯函数 `asksToRemember()` 算出）。
 *  ⚠️ `undefined` 必须与 `false` 区别对待：前者 = "调用方没接这条线" ⇒ 走既有行为（旧调用方逐字不变），
 *     否则"接线只做一半"会**静默放宽** INV-M41-03。
 */
test('A2 正控：用户确实要求记住（true）⇒ 未写入 + 成功口吻**仍必须替换**', () => {
  const out = applyResponseTruthPolicy({
    result: notWritten('pending_post_turn'),
    replyText: '行，记住了。',
    userAskedToRemember: true,
  })
  expect.ok(out.corrected, '记忆轮里未执行却保留了成功口吻 —— 守卫被关掉了')
})

test('A2 负控：这一轮不归记忆域管（false）⇒ 她的措辞**不得**被整轮顶掉', () => {
  const out = applyResponseTruthPolicy({
    result: notWritten('pending_post_turn'),
    replyText: '我记着这事呢，你刚说的我都听着。',
    userAskedToRemember: false,
  })
  expect.notOk(out.corrected, `非记忆轮的回复被顶成模板了：${out.replyText}`)
  expect.equal(out.replyText, '我记着这事呢，你刚说的我都听着。')
})

test('A2 兼容：不传这个事实（undefined）⇒ 逐字保持既有行为（不静默放宽）', () => {
  const withFact = applyResponseTruthPolicy({
    result: notWritten('pending_post_turn'),
    replyText: '行，记住了。',
    userAskedToRemember: true,
  })
  const withoutFact = applyResponseTruthPolicy({ result: notWritten('pending_post_turn'), replyText: '行，记住了。' })
  expect.ok(withFact.corrected)
  expect.ok(withoutFact.corrected, 'undefined 时行为变了 —— 旧调用方会被静默放宽')
  expect.equal(withoutFact.replyText, withFact.replyText)
})

test('A2 纯函数：asksToRemember 的召回与问句守卫（含事故原话）', () => {
  /* 真实事故那两句：第一句确实在要求记住；追问句**不是**（它才是被误替换的那一轮） */
  expect.ok(asksToRemember('记得在5:55提醒我去抢课,不要管我有没有回复收到'), '要求记住的一句被判成不要求')
  expect.notOk(asksToRemember('什么意思？'), '纯追问被判成要求记住 —— 事故会复现')
  expect.notOk(asksToRemember('你还记得那件事吗？'), '纯问句被判成要求记住')
  expect.ok(asksToRemember('帮我记住我喜欢喝热水'))
  expect.ok(asksToRemember('忘掉我之前说的那条'))
  expect.notOk(asksToRemember('今天天气不错'))
})

test('C8：真实成功才允许成功口吻（written / already_applied 不改写）', () => {
  const w = applyResponseTruthPolicy({ result: written(), replyText: '行，记住了。' })
  expect.notOk(w.corrected)
  expect.equal(w.executed, true)

  const a = applyResponseTruthPolicy({ result: alreadyApplied(), replyText: '那个我早记着了。' })
  expect.notOk(a.corrected)
  expect.equal(a.executed, true)
})

test('C9：没有显式记忆指令时，executed = undefined（可被测试直接检查）', () => {
  const out = applyResponseTruthPolicy({ result: undefined, replyText: '嗯，我在听。' })
  expect.equal(out.executed, undefined)
  expect.notOk(out.corrected)
})

test('替换后的句子按 reason 区分，且**每一条自己都不违规**', () => {
  const reasons = [
    'content_unresolved',
    'target_not_found',
    'target_ambiguous',
    'persistence_failed',
    'something_else',
  ]
  const sentences = new Set<string>()
  for (const reason of reasons) {
    const out = applyResponseTruthPolicy({ result: notWritten(reason), replyText: '记住了。' })
    expect.ok(out.corrected, `${reason} 没有被替换`)
    /*
     * 闭环：拿替换后的句子**再过一次**策略。
     * 若它自己带成功口吻，第二次还会被判定为违规 —— 那说明
     * 守卫的输出不满足守卫自己的契约。那种缺陷表现为
     * "替换一次之后仍然在犯规"，而只看第一次是看不出来的。
     */
    const second = applyResponseTruthPolicy({ result: notWritten(reason), replyText: out.replyText })
    expect.notOk(second.corrected, `替换句自身违规（${reason}）：${out.replyText}`)
    sentences.add(out.replyText)
  }
  expect.equal(sentences.size, reasons.length, '不同 reason 应给出不同的如实表述')
})

test('成功口吻表不含纯应声词（避免误伤）', () => {
  for (const loose of ['好', '行', '嗯', '知道了', '收到']) {
    expect.notOk(
      RESPONSE_SUCCESS_MARKERS.includes(loose),
      `"${loose}" 是泛应声词，收进成功口吻表会大量误伤`
    )
  }
})

// ===========================================================================
// 23. 后台抽取的 Source Firewall（计划书第 124–127 / 148–149 / 154 节）
// ===========================================================================

group('后台抽取 · Source Firewall')

/** 生产 ingress 各一份（夹具站在**真实入口**上，而不是自己声明来源） */
const HUMAN_CONSOLE_INGRESS = createHumanConsoleUserTurnIngress()
const CHARACTER_TURN_INGRESS = createCharacterAssistantTurnIngress()

/** 造一条 `ProcessorEventView`（抽取器的输入**只有**这个形状） */
function view(input: {
  sequence: number
  actorType: 'user' | 'character' | 'system'
  content: string
  /**
   * M5.1.1 / Phase 4a（ADR-043 `DR-6`）：这条行是**怎么被写进来的**。
   *
   * ```text
   * human_console   交互式人类控制台：受信鉴证 + confirmed ⇒ 来源**已确立**（作者 = 用户）
   * character_turn  她的输出边界：受信鉴证 + confirmed，但作者是**她** ⇒ 知道"不是他"
   * legacy          没有信封（v7 之前的历史行 / 未经受信 ingress 的写入）⇒ 来源未确立
   * ```
   *
   * 缺省按 `actorType` 取（user → human_console，character → character_turn，其余 legacy）。
   *
   * ==========================================================================
   *  ⚠️ 这里**没有**任何手写的 `TrustedOriginReading`
   * ==========================================================================
   * 夹具声明的是"事件行是怎么产生的"，然后走**三步生产代码**：
   *
   *     生产 ingress（鉴证） → createConversationEvent() → processorEventViewOf()
   *
   * 来源读数由生产侧的派生函数从"事件行的列"上取。因此这条夹具既没有复制
   * 派生逻辑，也不可能声明出生产造不出来的组合 —— 而"夹具自己声明来源"
   * 正是 `DR-6` 明令不算数的那种证据。
   */
  ingress?: 'human_console' | 'character_turn' | 'legacy'
}): ReturnType<typeof processorEventViewOf> {
  const characterId = asCharacterId(String(CHARACTER.id))
  const ingress =
    input.ingress ??
    (input.actorType === 'user'
      ? 'human_console'
      : input.actorType === 'character'
        ? 'character_turn'
        : 'legacy')

  const trustedAttribution =
    ingress === 'human_console'
      ? HUMAN_CONSOLE_INGRESS.attest({
          characterId: String(characterId),
          presenterActorId: String(USER.id),
          userId: String(USER.id),
        })
      : ingress === 'character_turn'
        ? CHARACTER_TURN_INGRESS.attest({
            characterId: String(characterId),
            presenterActorId: String(characterId),
          })
        : undefined

  const event = createConversationEvent({
    characterId,
    conversationId: asConversationId('conv1'),
    sequence: input.sequence,
    conversationSequence: input.sequence,
    type:
      input.actorType === 'user'
        ? 'user_message'
        : input.actorType === 'character'
          ? 'assistant_message'
          : 'system_event',
    actorType: input.actorType,
    actorId:
      input.actorType === 'user'
        ? String(USER.id)
        : input.actorType === 'character'
          ? String(characterId)
          : 'system',
    content: input.content,
    createdAt: T0,
    ...(trustedAttribution !== undefined ? { trustedAttribution } : {}),
  })

  return processorEventViewOf(event)
}

const RESOLVE_CONTEXT = {
  owner: CHARACTER,
  speaker: USER,
  processor: 'memory-extractor',
  processorVersion: 'memory-extractor@1',
}

test('计划书第 125 节：prompt **必须**带 Actor（否则模型会把她的归到用户头上）', () => {
  const prompt = buildExtractionPrompt({
    views: [
      view({ sequence: 1, actorType: 'user', content: '我不吃香菜' }),
      view({ sequence: 2, actorType: 'character', content: '我记住了' }),
    ],
    knownPredicates: [
      { key: 'food.preference.cilantro', description: '对香菜的偏好' },
    ],
  })
  expect.includes(prompt, 'Event 1 Actor=USER')
  expect.includes(prompt, 'Event 2 Actor=CHARACTER')
  // 第 46 节：严格 Schema，且必须允许"没有值得记的"
  expect.includes(prompt, '"candidates"')
  expect.includes(prompt, '"evidenceEventSequences"')
  expect.includes(prompt, '没有值得记的就返回')
})

test('⚠️ 回归：prompt 里的 predicate **必须带 description**（否则会选错槽位）', () => {
  /*
   * ==========================================================================
   *  这条断言来自一个真实测出来的错槽位
   * ==========================================================================
   * 第一版 prompt 只把 key 拼成一行逗号串：
   *
   *     food.preference.cilantro, food.avoid.general, ...
   *
   * 于是「不吃香菜」有两个都讲得通的键，模型只能靠键名字面猜。
   * 实测（真实模型档，M4X-030「记住，我不吃香菜」）它选了
   * `food.avoid.general` —— 而 `food.preference.cilantro` 的 examples
   * 里明确写着 `'我不吃香菜'`。
   *
   * 这不是"少记一条"，而是**同一事实落到两个槽位**：
   * canonical key 不同 → 去重层认不出是同一件事 →
   * 用户说"我现在能吃香菜了"时找不到要推翻的那一条。
   * 规范化键的整套设计都建立在"同一事实落同一槽位"上。
   *
   * 所以这里锁住：description 必须在 prompt 里出现。
   */
  const prompt = buildExtractionPrompt({
    views: [view({ sequence: 1, actorType: 'user', content: '我不吃香菜' })],
    knownPredicates: [
      { key: 'food.preference.cilantro', description: '对香菜的偏好' },
      { key: 'food.avoid.general', description: '其他明确表达的食物回避（宽泛槽位）' },
    ],
  })

  // description 必须在
  expect.includes(prompt, '对香菜的偏好')
  expect.includes(prompt, '宽泛槽位')
  // 且必须是 key：description 的配对形式，不是裸逗号串
  expect.includes(prompt, '- food.preference.cilantro：对香菜的偏好')
  // 消歧规则必须在（"选最具体的槽位"）
  expect.includes(prompt, '选最具体的槽位')
  /*
   * ⚠️ examples **不该**进 prompt：那是给人和审计看的说明，
   *    送进去会变成 few-shot，模型开始照抄例句而不是理解语义。
   *    这条断言把那个边界也锁住 —— 将来有人"顺手"把 examples
   *    也塞进去时会失败。
   */
  expect.notIncludes(prompt, '我现在能吃香菜了')
})

test('⚠️ 计划书第 148 节：她的输出**不能**建立用户事实（权威由证据推导）', () => {
  // 这是整个 M4 最关键的一条断言。模型若能把 authority 写成
  // EXPLICIT_USER_STATEMENT，她的猜测就会变成关于用户的长期事实。
  const descriptors = [
    {
      memoryType: 'person_fact' as const,
      subjectToken: 'USER' as const,
      claim: { predicate: 'user.birthday', value: '08-03' },
      evidenceEventSequences: [1],
    },
  ]
  const resolved = resolveCandidates(descriptors, {
    ...RESOLVE_CONTEXT,
    events: [view({ sequence: 1, actorType: 'character', content: '我猜是 8 月 3 日' })],
  })

  expect.equal(resolved.length, 1)
  expect.notOk(resolved[0].ok, '她的猜测被允许建立用户事实 —— 这是 M4 Critical Test')
  if (!resolved[0].ok) {
    /*
     * F4（M5.1.1 / Phase 4a）：**期望值更新**，判据形状不变（仍然要求"必须被拒"）。
     *
     * 4a 的来源资格闸在权威推导**之前**跑，而这条证据是**角色**的输出
     * （`view({ actorType: 'character' })` 现在带的是"她的输出边界"那条受信通道的鉴证）⇒
     * 来源**已确立但不是人类** ⇒ 先于既有闸 4 报 `evidence_origin_contradicts_claim`。
     *
     * 既有理由码 `evidence_cannot_support_external_fact` 仍在（闸 4 未动），
     * 只是对"她自己输出"这一类不再是最先触发的那个 —— 两个理由码都表示"被拒"。
     */
    expect.includes(resolved[0].rejection.reason, 'evidence_origin_contradicts_claim')
  }
})

test('计划书第 148 节：候选描述里**没有** authority 字段（模型写不进来）', () => {
  // 反向守卫：若有人给 CandidateDescriptor 加了 authority 字段，
  // 模型就能自己声明"我的话算事实"。这条断言的是**行为**。
  const descriptor = {
    memoryType: 'person_fact' as const,
    subjectToken: 'USER' as const,
    claim: { predicate: 'x.y', value: 1 },
    evidenceEventSequences: [1],
    // 故意多写一个 authority —— 必须被**忽略**
    authority: 'EXPLICIT_CORRECTION',
  }
  const resolved = resolveCandidates([descriptor as never], {
    ...RESOLVE_CONTEXT,
    events: [view({ sequence: 1, actorType: 'character', content: '我猜你喜欢猫' })],
  })
  // 证据是她自己的话 → 仍然建不了用户事实（authority 没有被采纳）
  expect.notOk(resolved[0].ok)
})

test('计划书第 126 节：引用不存在的证据序号 → 丢弃整条候选', () => {
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'preference' as const,
        subjectToken: 'USER' as const,
        claim: { predicate: 'food.preference.cilantro', value: 'dislike' },
        evidenceEventSequences: [1, 999],
      },
    ],
    {
      ...RESOLVE_CONTEXT,
      events: [view({ sequence: 1, actorType: 'user', content: '我不吃香菜' })],
    }
  )
  expect.notOk(resolved[0].ok, '引用了不存在的证据序号却被接受 —— 来源是编的')
  if (!resolved[0].ok) {
    expect.includes(resolved[0].rejection.reason, 'evidence_sequence_not_in_batch')
  }
})

test('用户陈述 + 事实类 → 通过，且权威是 EXPLICIT_USER_STATEMENT', () => {
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'preference' as const,
        subjectToken: 'USER' as const,
        claim: { predicate: 'food.preference.cilantro', value: 'dislike' },
        evidenceEventSequences: [1],
      },
    ],
    {
      ...RESOLVE_CONTEXT,
      events: [view({ sequence: 1, actorType: 'user', content: '我不吃香菜' })],
    }
  )
  expect.ok(resolved[0].ok)
  if (resolved[0].ok) {
    expect.equal(resolved[0].candidate.authority, 'EXPLICIT_USER_STATEMENT')
    expect.equal(resolved[0].candidate.epistemicStatus, 'reported')
  }
})

test('计划书第 149 节：她编的经历建不了 SELF_EXPERIENCE（证据全是她自己的话）', () => {
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'self_experience' as const,
        subjectToken: 'CHARACTER' as const,
        episode: { summary: '她小时候经常去海边', participantTokens: ['CHARACTER'] },
        evidenceEventSequences: [1],
      },
    ],
    {
      ...RESOLVE_CONTEXT,
      events: [view({ sequence: 1, actorType: 'character', content: '可能是海边吧' })],
    }
  )
  expect.notOk(resolved[0].ok, '她编的童年被允许存成经历')
})

test('计划书第 150 节：真实发生过的互动**可以**成为 SELF_EXPERIENCE', () => {
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'self_experience' as const,
        subjectToken: 'CHARACTER' as const,
        episode: {
          summary: '苏沐薇和 Alex 一起解决了记忆架构的问题',
          participantTokens: ['CHARACTER', 'USER'],
          topicTags: ['memory'],
        },
        evidenceEventSequences: [1, 2],
      },
    ],
    {
      ...RESOLVE_CONTEXT,
      events: [
        view({ sequence: 1, actorType: 'user', content: '帮我看看这个记忆架构' }),
        view({ sequence: 2, actorType: 'character', content: '我觉得应该先想清楚证据' }),
      ],
    }
  )
  expect.ok(resolved[0].ok, '真实发生过的共同经历被拒绝了 —— 那是过度修正')
  if (resolved[0].ok) {
    expect.equal(resolved[0].candidate.epistemicStatus, 'observed')
    expect.equal(resolved[0].candidate.subjects.length, 2)
  }
})

test('计划书第 154 节：tool 事件**不能**被 M4 的抽取器处理（伪装通道）', () => {
  let threw = false
  let code = ''
  try {
    processorEventViewOf({
      id: 'cev:x:y:1' as never,
      characterId: 'char_sumuwei' as never,
      conversationId: 'c' as never,
      sequence: 1,
      conversationSequence: 1,
      type: 'tool_event',
      actorType: 'tool',
      content: '{"temperature": 20}',
      sourceKind: 'tool_output',
      sourceAuthority: 'TOOL_OBSERVATION',
      epistemicSource: 'tool_observation',
      schemaVersion: 1,
      createdAt: T0,
    } as never)
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, 'tool_event 被塞进了抽取器 —— 它只能靠伪装成 character/system 进来')
  expect.includes(code, 'tool_event_not_extractable_in_m4')
})

test('parseCandidatesJson：不合法 JSON → undefined（**不猜、不修复**，计划书第 146 节）', () => {
  expect.equal(parseCandidatesJson('我认为这一轮值得记住'), undefined)
  expect.equal(parseCandidatesJson('{"candidates":'), undefined)
  expect.equal(parseCandidatesJson('not json at all'), undefined)
  // 合法但空是一个**正常结果**（第 50 节）
  expect.deepEqual(parseCandidatesJson('{"candidates":[]}'), [])
})

test('parseCandidatesJson：单条不合法只丢那一条，**不让整批失败**', () => {
  const raw = JSON.stringify({
    candidates: [
      {
        memoryType: 'preference',
        subjectToken: 'USER',
        claim: { predicate: 'food.preference.cilantro', value: 'dislike' },
        evidenceEventSequences: [1],
      },
      // 缺 subjectToken → 丢掉这一条
      { memoryType: 'preference', claim: { predicate: 'x', value: 1 }, evidenceEventSequences: [1] },
      // 证据为空 → 丢掉
      {
        memoryType: 'preference',
        subjectToken: 'USER',
        claim: { predicate: 'x', value: 1 },
        evidenceEventSequences: [],
      },
    ],
  })
  const parsed = parseCandidatesJson(raw)
  expect.ok(parsed !== undefined)
  expect.equal(parsed!.length, 1, '不合法的单条应当只丢它自己')
})

test('离线抽取器：只看用户的话，她的话不产生候选', async () => {
  const extractor = new RuleBasedMemoryExtractor()
  const result = await extractor.process({
    views: [
      view({ sequence: 1, actorType: 'character', content: '我不吃香菜' }),
      view({ sequence: 2, actorType: 'user', content: '我也不吃香菜' }),
    ],
    owner: CHARACTER,
    speaker: USER,
  })
  expect.equal(result.candidates.length, 1, '她的话也产生了候选')
  expect.equal(result.candidates[0].sourceRefs[0].id, 'cev:char_sumuwei:conv1:2')
})

test('离线抽取器：无模型入口时 LlmMemoryExtractor **抛错**（不返回空）', async () => {
  const extractor = new LlmMemoryExtractor()
  let code = ''
  try {
    await extractor.process(
      {
        views: [view({ sequence: 1, actorType: 'user', content: '我不吃香菜' })],
        owner: CHARACTER,
        speaker: USER,
      },
      { processorName: 'memory-extractor', processorVersion: 'memory-extractor@1' }
    )
  } catch (error) {
    code = String((error as { code?: string }).code)
  }
  // 返回空会被读成"这批对话不值得记"，而真实原因是"抽取器没跑"
  expect.includes(code, 'memory_extractor_without_model')
})

test('LlmMemoryExtractor：模型输出非法 JSON → 抛错（job failed 而不是"0 条候选"）', async () => {
  const extractor = new LlmMemoryExtractor()
  let code = ''
  try {
    await extractor.process(
      {
        views: [view({ sequence: 1, actorType: 'user', content: '我不吃香菜' })],
        owner: CHARACTER,
        speaker: USER,
      },
      {
        processorName: 'memory-extractor',
        processorVersion: 'memory-extractor@1',
        invokeModel: async () => '我认为这一轮值得记住',
      }
    )
  } catch (error) {
    code = String((error as { code?: string }).code)
  }
  expect.includes(code, 'memory_extractor_malformed_output')
})

// ===========================================================================
// 24. Value Gate（计划书第 50–53 节）
// ===========================================================================

group('Value Gate')

test('计划书第 52 节：**confidence ≠ importance** —— 高置信低价值可以被表达', () => {
  // "我今天午饭吃了面"：confidence 极高，长期 value 极低。
  // 这条记忆（一个未登记槽位的一次性事实）必须**被值闸拒绝**，
  // 而它的 confidence 必须**原样保留**在候选里（那是不同的信息）。
  const cand = createMemoryCandidate({
    owner: CHARACTER,
    type: 'person_fact',
    content: { kind: 'claim', subject: USER, predicate: 'lunch.today', value: 'noodles' },
    subjects: [USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.99,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })

  const gate = applyValueGate([cand])
  expect.equal(gate[0].ok, false, '一次性事实通过了值闸 —— 系统会过度记忆')
  expect.equal(cand.confidence, 0.99, 'confidence 必须原样保留（它与 importance 是两件事）')
  if (!gate[0].ok) {
    expect.equal(gate[0].reason, 'low_value')
  }
})

test('稳定偏好通过值闸，且 importance 由因子算出（可解释）', () => {
  const cand = createMemoryCandidate({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'food.preference.cilantro',
      value: 'dislike',
    },
    subjects: [USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
  const gate = applyValueGate([cand])
  expect.ok(gate[0].ok, '稳定偏好被值闸拒绝了')
  if (gate[0].ok) {
    expect.ok(gate[0].evaluation.factors.durability > 0, '因子必须可复核')
    expect.ok(gate[0].evaluation.factors.futureUsefulness > 0)
    expect.equal(gate[0].evaluation.factors.predicateRegistered, 1, '已登记槽位应当被标出')
  }
})

test('计划书第 53 节：显式要求记住**免于阈值**，但 importance 不被写成 1.0', () => {
  /*
   * ⚠️ 语料必须真的是**低价值**的。第一版用了 `some.one.off.fact`，
   * 而它实测 importance = 0.783（durability 0.95 + usefulness 0.6 +
   * relevance 0.8 的三项平均）—— 也就是说它**应当**通过值闸。
   *
   * 那次失败的教训：值闸判的是**因子**，不是"这个名字听起来重不重要"。
   * 一个未登记但稳定的谓词本来就该通过（计划书第 19 节允许自由键）；
   * 值闸真正拒的是**时间限定的短期状态**（计划书第 11 / 52 节的例子）。
   */
  const cand = createMemoryCandidate({
    owner: CHARACTER,
    type: 'person_fact',
    content: { kind: 'claim', subject: USER, predicate: 'lunch.today', value: 'noodles' },
    subjects: [USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.9,
    processor: 'explicit-memory',
    processorVersion: 'explicit-memory@1',
  })

  const background = applyValueGate([cand])
  expect.equal(background[0].ok, false, '低价值事实在后台路径应当被拒')

  const explicit = applyValueGate([cand], { explicit: true })
  expect.ok(explicit[0].ok, '显式要求记住被阈值拒绝了')
  if (explicit[0].ok) {
    // "覆盖"的是阈值，不是字段 —— 用户没说"这条最重要"
    expect.equal(explicit[0].evaluation.explicitOverride, true)
    expect.ok(
      explicit[0].candidate.importance < 1,
      'importance 被写成了 1.0 —— 那是用户没说过的话'
    )
  }
})

test('时间限定的谓词被判为短期状态（计划书第 11 / 52 节的"今天午饭吃了面"）', () => {
  // 计划书第 11 节："Alex 今天似乎心情不好" 不适合 PERSON_FACT（短期状态）
  // 计划书第 52 节："我今天午饭吃了面" confidence 高但长期 value 低
  for (const predicate of ['lunch.today', 'mood.today', 'status.now', 'plan.tomorrow']) {
    expect.ok(isTimeScopedPredicate(predicate), `${predicate} 没有被判为时间限定`)
  }
  for (const predicate of ['education.status', 'food.preference.cilantro', 'device.primary']) {
    expect.notOk(isTimeScopedPredicate(predicate), `${predicate} 被误判为时间限定`)
  }
})

test('时间限定**不等于**直接拒绝（"我今天决定戒烟"可能意义重大）', () => {
  // 降权让"值不值得"由总分决定，而不是由"有没有时间词"决定。
  // 直接拒会丢掉真正重要的、恰好带时间限定的事实。
  const strong = createMemoryCandidate({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'food.preference.cilantro',
      value: 'dislike',
      // 一个**稳定的**偏好；谓词本身不带时间限定
    },
    subjects: [USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
  const evaluation = evaluateValue(strong, { modelLongTermValue: 0.9 })
  expect.ok(evaluation.passes, '稳定的偏好被值闸拒了')
})

test('值闸参数可配置（计划书第 45 节的态度：不硬编码成领域规则）', () => {
  const cand = createMemoryCandidate({
    owner: CHARACTER,
    type: 'person_fact',
    content: { kind: 'claim', subject: USER, predicate: 'lunch.today', value: 'noodles' },
    subjects: [USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.99,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
  // 阈值降到 0 → 同一条候选现在通过（证明阈值真的在起作用）
  const permissive = applyValueGate([cand], { threshold: 0 })
  expect.ok(permissive[0].ok)
})

test('模型自评 longTermValue 与规则因子**加权**（任一方不能单独决定）', () => {
  const cand = createMemoryCandidate({
    owner: CHARACTER,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate: 'food.preference.cilantro',
      value: 'dislike',
    },
    subjects: [USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
  const withoutModel = evaluateValue(cand)
  const withLowModel = evaluateValue(cand, { modelLongTermValue: 0.1 })
  const withHighModel = evaluateValue(cand, { modelLongTermValue: 1 })

  expect.ok(withLowModel.importance < withoutModel.importance, '模型给低分应当拉低 importance')
  expect.ok(withHighModel.importance > withoutModel.importance, '模型给高分应当拉高 importance')
  // 但都不能把它拉到极端（规则因子仍在起作用）
  expect.ok(withLowModel.importance > 0, '模型单独把 importance 拉到 0')
  expect.ok(withHighModel.importance < 1, '模型单独把 importance 拉到 1')
})

test('计划书第 51 节：**不加** relationship / emotional / goal 维度', () => {
  const cand = createMemoryCandidate({
    owner: CHARACTER,
    type: 'episode',
    content: {
      kind: 'episode',
      summary: '他们讨论了记忆架构',
      participants: [CHARACTER, USER],
      eventRefs: [evidence(1).id],
      topicTags: ['memory'],
    },
    subjects: [CHARACTER, USER],
    sourceRefs: [evidence(1)],
    epistemicStatus: 'observed',
    authority: 'DIRECT_INTERACTION',
    importance: 0.5,
    confidence: 0.8,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
  })
  const evaluation = evaluateValue(cand)
  const keys = Object.keys(evaluation.factors)
  for (const forbidden of ['relationshipRelevance', 'emotionalSalience', 'goalRelevance']) {
    expect.notOk(
      keys.includes(forbidden),
      `提前加了 ${forbidden} —— 计划书第 51 节明确不加`
    )
  }
  expect.ok(keys.includes('episodeSignificance'), 'Episode 的显著性应当参与')
})

// ===========================================================================
// 25. 水位补洞（计划书第 162–163 节，审计 §6 F7）
// ===========================================================================

group('水位补洞')

function job(input: {
  from: number
  to: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  id?: string
}) {
  return {
    id: (input.id ?? `job:${input.from}-${input.to}`) as never,
    characterId: 'char_sumuwei' as never,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    triggerKind: 'conversation' as const,
    sourceFromSequence: input.from,
    sourceToSequence: input.to,
    idempotencyKey: `idem:${input.from}-${input.to}`,
    status: input.status,
    retryCount: 0,
    createdAt: T0,
  }
}

test('⚠️ 中间有洞时**不得**报告"已完成到最大值"（计划书第 162 节）', () => {
  /*
   * 这是水位机制的全部意义所在。
   *
   *     Job A = [1,5]     failed
   *     Job B = [6,10]    completed
   *
   * 若水位取"已完成的最大值"，它会变成 10 —— 而 1–5 **根本没做**。
   * 那 5 个事件永远不会被处理，而且**没有任何信号**。
   */
  const frontier = contiguousFrontierFrom([
    job({ from: 1, to: 5, status: 'failed' }),
    job({ from: 6, to: 10, status: 'completed' }),
  ])
  expect.equal(frontier.throughSequence, 0, '水位越过了失败的任务 —— 中间洞丢失')
  expect.ok(frontier.blockedAt !== undefined)
  expect.equal(frontier.blockedAt?.from, 1)
})

test('洞被补上之后水位一次推进到连续前缀末端', () => {
  const frontier = contiguousFrontierFrom([
    job({ from: 1, to: 5, status: 'completed' }),
    job({ from: 6, to: 10, status: 'completed' }),
  ])
  expect.equal(frontier.throughSequence, 10)
  expect.equal(frontier.blockedAt, undefined)
})

test('区间**允许重叠**（重跑），且重叠不会让水位卡住', () => {
  // 严格首尾相接的要求会让一次重跑让水位永久停住 —— 那比"洞丢失"更糟
  const frontier = contiguousFrontierFrom([
    job({ from: 1, to: 5, status: 'completed' }),
    job({ from: 1, to: 5, status: 'completed' }), // 重跑
    job({ from: 5, to: 10, status: 'completed' }), // 重叠 1 个
  ])
  expect.equal(frontier.throughSequence, 10)
})

test('没有"从 1 开始"的任务 → 水位是 0（**不推进**，因为不知道起点）', () => {
  const frontier = contiguousFrontierFrom([job({ from: 100, to: 105, status: 'completed' })])
  expect.equal(frontier.throughSequence, 0, '凭空猜了一个起点 —— 那会造出第一个洞')
})

test('pending / running 都不算完成', () => {
  expect.equal(
    contiguousFrontierFrom([job({ from: 1, to: 5, status: 'running' })]).throughSequence,
    0
  )
  expect.equal(
    contiguousFrontierFrom([job({ from: 1, to: 5, status: 'pending' })]).throughSequence,
    0
  )
})

test('空任务列表 → 水位 0（新角色的真实情况）', () => {
  expect.equal(contiguousFrontierFrom([]).throughSequence, 0)
})

test('乱序传入不影响结果（内部会按 from 排序）', () => {
  const frontier = contiguousFrontierFrom([
    job({ from: 6, to: 10, status: 'completed' }),
    job({ from: 1, to: 5, status: 'completed' }),
  ])
  expect.equal(frontier.throughSequence, 10)
})

test('已完成前缀**内部**有未完成任务时，水位回退到它之前', () => {
  // A=[1,5] completed、B=[3,4] failed（重叠且失败）
  // frontier 从 A 得到 5，但 B 覆盖的 3–4 其实没处理完
  const frontier = contiguousFrontierFrom([
    job({ from: 1, to: 5, status: 'completed' }),
    job({ from: 3, to: 4, status: 'failed', id: 'job:3-4' }),
  ])
  expect.equal(frontier.throughSequence, 2, '水位声称 3–4 处理完了，但它们失败了')
  expect.equal(frontier.blockedAt?.from, 3)
})

// ===========================================================================
// 26. 抽取任务的幂等键（计划书第 69 节）
// ===========================================================================

group('抽取任务的幂等键')

test('同一区间 + 同一版本 → 同一个键（重跑会命中幂等）', () => {
  const key = () =>
    memoryExtractionIdempotencyKey({
      characterId: 'char_sumuwei' as never,
      processor: 'memory-extractor',
      processorVersion: 'memory-extractor@1',
      fromSequence: 100,
      toSequence: 105,
    })
  expect.equal(key(), key())
})

test('processorVersion 编进键（@2 不被 @1 的记录拦住，计划书第 66–67 节）', () => {
  const v1 = memoryExtractionIdempotencyKey({
    characterId: 'char_sumuwei' as never,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    fromSequence: 100,
    toSequence: 105,
  })
  const v2 = memoryExtractionIdempotencyKey({
    characterId: 'char_sumuwei' as never,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@2',
    fromSequence: 100,
    toSequence: 105,
  })
  expect.notOk(
    v1 === v2,
    '换了版本却算出同一个键 —— 精确重处理 v2 产物会被旧的幂等记录拦住'
  )
})

test('不同区间 → 不同键（相邻批次是不同的工作单元）', () => {
  const a = memoryExtractionIdempotencyKey({
    characterId: 'char_sumuwei' as never,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    fromSequence: 100,
    toSequence: 105,
  })
  const b = memoryExtractionIdempotencyKey({
    characterId: 'char_sumuwei' as never,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    fromSequence: 106,
    toSequence: 110,
  })
  expect.notOk(a === b)
})

test('重试 policy 有上界（否则持续失败会无限调模型）', () => {
  expect.ok(canRetryMemoryJob(job({ from: 1, to: 5, status: 'failed' })))
  expect.notOk(
    canRetryMemoryJob({ ...job({ from: 1, to: 5, status: 'failed' }), retryCount: 3 })
  )
  expect.ok(canRetryMemoryJob({ ...job({ from: 1, to: 5, status: 'failed' }), retryCount: 3 }, 5))
})

// ===========================================================================
// 27. 配置开关的边界（计划书第 45 / 53 节）
// ===========================================================================

group('Memory 配置开关')

test('后台抽取默认 **off**（避免"某次随手聊天悄悄建了记忆"）', () => {
  const flags = readKernelFlags({} as NodeJS.ProcessEnv)
  expect.equal(flags.memoryEnabled, true)
  expect.equal(flags.memoryExplicitEnabled, true)
  expect.equal(
    flags.memoryBackgroundEnabled,
    false,
    '后台抽取默认开启会让记忆在用户没要求时悄悄增长'
  )
})

/*
 * S8 / ADR-094 `D01`：故事认知总开关的缺省值 + AST 装配检查。
 *
 * 只检查实际属性读取和调用语法，注释与字符串不得通过。
 * 这不证明运行时可达或有提交可消费；行为主张由 postlv2:s8:daily:e2e
 * 的真实 main.ts、账本/水位读回及入口/消费缺席负控承担（L-S8-30）。
 */
test('故事认知开关默认 off，main.ts 的 AST 装配检查不接受注释或字符串', () => {
  const flags = readKernelFlags({} as NodeJS.ProcessEnv)
  expect.equal(
    flags.storyCognitionEnabled,
    false,
    '故事认知默认开启会让剧情经历在用户没要求时进入认知'
  )
  const main = readFileSync('src/main.ts', 'utf8')
  const hasAssembly = (text: string): boolean => {
    const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true)
    let readsFlag = false
    let callsConsumer = false
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'storyCognitionEnabled') readsFlag = true
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'consumeOnce') callsConsumer = true
      ts.forEachChild(node, visit)
    }
    visit(source)
    return readsFlag && callsConsumer
  }
  expect.equal(hasAssembly(main), true, 'main.ts 必须有开关属性读取与 consumeOnce 调用语法；行为另由整链门验证')
  expect.equal(hasAssembly('// storyCognitionEnabled consumeOnce\nconst text = "flags.storyCognitionEnabled; cognition.consumeOnce()"'), false)
  expect.equal(hasAssembly('flags.storyCognitionEnabled; // cognition.consumeOnce()'), false)
  expect.equal(hasAssembly('cognition.consumeOnce(); // flags.storyCognitionEnabled'), false)
})

/*
 * S8 / `ADR-107` `R-1b`：**剧情选择解析**开关的缺省值 + 装配在场锁。
 *
 * ⚠️ 它与上面那条**分列**：`storyCognitionEnabled` 决定"装不装故事账本与入口"，
 *    本条决定"每轮**要不要多花一次模型调用**去解析用户的选择"。
 * ⚠️ 缺省必须是 `false`：开着它意味着**每轮一次额外出站**。
 * ⚠️ 这里的 `main.ts` 检查是**装配在场**（文本锁），**不作为行为主张** ——
 *    行为主张在 `postlv2:s8:choice:verify`（正控 / 开关关闭零调用 / 无活跃 run 零调用 /
 *    八条负控 / 恢复 / 无候选），文本锁测不到"入口有没有被真的调用"（`ADR-107` `R-4c`）。
 */
test('剧情选择解析开关默认 **off**（每轮多一次模型调用），且 `main.ts` 真的接了它', () => {
  const flags = readKernelFlags({} as NodeJS.ProcessEnv)
  expect.equal(
    flags.storyChoiceDecisionEnabled,
    false,
    '每轮多一次私有模型调用 ⇒ 缺省必须 off，否则用户没要求就会多出出站'
  )
  expect.equal(
    flags.storyChoiceDecisionTimeoutMs,
    8_000,
    '私有调用的缺省期限是 8000ms（有界；与 toolDecisionTimeoutMs 同型）'
  )
  const main = readFileSync('src/main.ts', 'utf8')
  /*
   * ⚠️ 判据是"**开关被消费** 且 **入口在 `main.ts` 里真的被调用**"，
   *    不是"某一行字面量还在"。
   * ⚠️ 2026-10-05 修订：调用点从 `runStoryChoiceTurn(...)` 改成
   *    `storyCognition.resolveChoiceTurn(...)` —— 因为 `m3.5:test` 的 `FC-T04`
   *    边界锁（`ADR-091 §2`）**不允许** `main.ts` 直接 import 故事账本/编排模块。
   *    这条锁跟着**新的**接线形状走，但**性质不变**：开关必须有消费者。
   */
  expect.equal(
    /storyChoiceDecisionEnabled/.test(main) && /\.resolveChoiceTurn\(/.test(main),
    true,
    'src/main.ts 必须既读 storyChoiceDecisionEnabled 又调 storyCognition.resolveChoiceTurn：只加开关不接线 = 惰性开关'
  )
  /*
   * 边界那一侧也必须真的有那个方法（否则上面那条可以把"调用一个不存在的方法"当成接线）。
   */
  const cognition = readFileSync('src/infrastructure/runtime/story-cognition.ts', 'utf8')
  expect.equal(
    /resolveChoiceTurn: async/.test(cognition),
    true,
    '故事边界模块（story-cognition.ts）必须真的实现 resolveChoiceTurn —— 否则 main.ts 调的是一个不存在的方法'
  )
})

test('抽取窗口与阈值可通过环境变量配置', () => {  const flags = readKernelFlags({
    MEMORY_EXTRACTION_WINDOW: '5',
    MEMORY_IMPORTANCE_THRESHOLD: '0.6',
  } as unknown as NodeJS.ProcessEnv)
  expect.equal(flags.memoryExtractionWindow, 5)
  expect.equal(flags.memoryImportanceThreshold, 0.6)
})

test('越界配置被**夹住**（不是静默接受一个会把整段历史塞进 prompt 的值）', () => {
  expect.equal(
    readKernelFlags({ MEMORY_EXTRACTION_WINDOW: '10000' } as unknown as NodeJS.ProcessEnv)
      .memoryExtractionWindow,
    10
  )
  expect.equal(
    readKernelFlags({ MEMORY_EXTRACTION_WINDOW: '0' } as unknown as NodeJS.ProcessEnv)
      .memoryExtractionWindow,
    1
  )
  expect.equal(
    readKernelFlags({ MEMORY_IMPORTANCE_THRESHOLD: '3' } as unknown as NodeJS.ProcessEnv)
      .memoryImportanceThreshold,
    1
  )
})

test('非法配置回落到缺省（而不是变成 NaN）', () => {
  const flags = readKernelFlags({
    MEMORY_EXTRACTION_WINDOW: 'abc',
    MEMORY_IMPORTANCE_THRESHOLD: 'xyz',
  } as unknown as NodeJS.ProcessEnv)
  expect.equal(flags.memoryExtractionWindow, 3)
  expect.equal(flags.memoryImportanceThreshold, 0.45)
})

test('describeKernelFlags 报出三个 memory 开关与两个数值参数', () => {
  const line = describeKernelFlags(readKernelFlags({} as NodeJS.ProcessEnv))
  expect.includes(line, 'memory')
  expect.includes(line, 'memory-explicit')
  expect.includes(line, 'memory-background')
  expect.includes(line, 'memory-window=')
  expect.includes(line, 'importance-threshold=')
})

// ===========================================================================
// 28. 冲突分析（计划书第 79–82 / 129–130 节，Phase 6）
// ===========================================================================

group('冲突分析（duplicate / temporal update / contradiction）')

/** 造一条 slot 内已存在的 ACTIVE 记录（用于冲突比对） */
function activeRecord(predicate: string, value: unknown) {
  return record('preference', claim({ predicate, value }))
}

/** 造一条同槽位的候选 */
function candidateFor(predicate: string, value: unknown) {
  return candidate('preference', claim({ predicate, value }))
}

test('计划书第 79 节：**Conflict 与 Duplicate 不是一回事**（同槽位同取值 vs 同槽位异取值）', () => {
  const existing = activeRecord('food.preference.cilantro', 'dislike')

  // 同槽位 + 同取值 → DUPLICATE
  const dup = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'dislike'),
    activeInSlot: [existing],
  })
  expect.equal(dup.verdict, 'DUPLICATE')

  // 同槽位 + 异取值、无变化标记 → CONTRADICTION（而不是 duplicate）
  const contradiction = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'like'),
    activeInSlot: [existing],
  })
  expect.equal(
    contradiction.verdict,
    'CONTRADICTION',
    '把"他改主意了/他自相矛盾"当成了"他又说了一遍"'
  )
})

test('计划书第 81 节：原话带状态变化标记 → TEMPORAL_UPDATE（不是矛盾）', () => {
  const existing = activeRecord('food.preference.cilantro', 'dislike')
  const analysis = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'like'),
    activeInSlot: [existing],
    utterance: '那个改一下，我现在能吃香菜了',
  })
  expect.equal(analysis.verdict, 'TEMPORAL_UPDATE')
  // 依据里必须**点名命中的那个标记**，只写"有变化标记"是不够的：
  // 审计时要能复核"为什么这句被判成更新而不是矛盾"
  expect.ok(analysis.reason.includes('现在'), `依据没有点名命中的标记：${analysis.reason}`)
})

test('计划书第 82 节：无变化标记的取值冲突 → CONTRADICTION（进 DISPUTED）', () => {
  const existing = activeRecord('food.preference.cilantro', 'dislike')
  const analysis = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'like'),
    activeInSlot: [existing],
    utterance: '我喜欢香菜',
  })
  expect.equal(analysis.verdict, 'CONTRADICTION')
})

test('槽位空 → NO_CONFLICT（走 CREATE）', () => {
  const analysis = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'dislike'),
    activeInSlot: [],
  })
  expect.equal(analysis.verdict, 'NO_CONFLICT')
  expect.equal(resolveConflict(analysis).action, 'CREATE')
})

test('Episode 家族没有槽位 → NO_CONFLICT（去重走第三层语义判别）', () => {
  const analysis = analyzeConflict({
    candidate: candidate('episode', episode()),
    activeInSlot: [activeRecord('food.preference.cilantro', 'dislike')],
  })
  expect.equal(analysis.verdict, 'NO_CONFLICT')
  expect.includes(resolveConflict(analysis).reason, '第三层')
})

test('⚠️ 槽位上有太多 ACTIVE → AMBIGUOUS + NEEDS_REVIEW（不挑一条来比）', () => {
  // 同一槽位上堆了 4 条 ACTIVE —— 正常流程下 supersede 会让旧条离开 active，
  // 因此这本身是一个**需要被看见的健康问题**，而不是"随便挑一条比对"
  const many = [
    activeRecord('food.preference.cilantro', 'dislike'),
    activeRecord('food.preference.cilantro', 'like'),
    activeRecord('food.preference.cilantro', 'neutral'),
    activeRecord('food.preference.cilantro', 'unknown'),
  ]
  const analysis = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'like'),
    activeInSlot: many,
  })
  expect.equal(analysis.verdict, 'AMBIGUOUS')
  expect.equal(resolveConflict(analysis).action, 'NEEDS_REVIEW')
})

test('三种裁决映射到三种**不同**的处置动作', () => {
  const existing = activeRecord('food.preference.cilantro', 'dislike')

  expect.equal(
    resolveConflict(
      analyzeConflict({
        candidate: candidateFor('food.preference.cilantro', 'dislike'),
        activeInSlot: [existing],
      })
    ).action,
    'REJECT_DUPLICATE'
  )
  expect.equal(
    resolveConflict(
      analyzeConflict({
        candidate: candidateFor('food.preference.cilantro', 'like'),
        activeInSlot: [existing],
        utterance: '我现在能吃了',
      })
    ).action,
    'SUPERSEDE'
  )
  expect.equal(
    resolveConflict(
      analyzeConflict({
        candidate: candidateFor('food.preference.cilantro', 'like'),
        activeInSlot: [existing],
        utterance: '我喜欢香菜',
      })
    ).action,
    'MARK_DISPUTED'
  )
})

test('变化标记表可以识别常见说法，且**不误判**普通陈述', () => {
  for (const utterance of ['我现在能吃香菜了', '我已经戒咖啡了', '那个改一下', '后来我变了']) {
    expect.ok(
      findTemporalChangeMarker(utterance) !== undefined,
      `「${utterance}」的状态变化标记没被识别 —— 它会被当成矛盾`
    )
  }
  for (const utterance of ['我喜欢香菜', '我不吃香菜', '我特别喜欢蓝色']) {
    expect.equal(
      findTemporalChangeMarker(utterance),
      undefined,
      `「${utterance}」被误判成状态变化 —— 它会错误覆盖用户之前说过的话`
    )
  }
})

test('**没有原话**时保守判为矛盾（宁可进 DISPUTED，不可错误覆盖）', () => {
  const existing = activeRecord('food.preference.cilantro', 'dislike')
  const analysis = analyzeConflict({
    candidate: candidateFor('food.preference.cilantro', 'like'),
    activeInSlot: [existing],
    // 没有 utterance
  })
  expect.equal(
    analysis.verdict,
    'CONTRADICTION',
    '没有原话时判成 temporal update 会**静默覆盖**用户之前说过的话'
  )
})

// ===========================================================================
// 29. 槽位级指纹（去重第二层的判定材料）
// ===========================================================================

group('槽位级指纹')

test('同槽位同取值 → 同 slotFingerprint（即使**内容**不同）', () => {
  const a = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'dislike' }))
  const b = record('preference', claim({ predicate: 'Food.Preference.Cilantro', value: 'dislike' }))
  const sa = slotOfRecord(a)
  const sb = slotOfRecord(b)
  expect.equal(sa?.canonicalKey, sb?.canonicalKey, '规范化后的谓词应当算出同一槽位')
  expect.equal(sa?.slotFingerprint, sb?.slotFingerprint)
})

test('同槽位**异取值** → 同 canonicalKey 但不同 slotFingerprint', () => {
  const a = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'dislike' }))
  const b = record('preference', claim({ predicate: 'food.preference.cilantro', value: 'like' }))
  const sa = slotOfRecord(a)
  const sb = slotOfRecord(b)
  expect.equal(sa?.canonicalKey, sb?.canonicalKey, '它们是同一个事实槽位')
  expect.notOk(
    sa?.slotFingerprint === sb?.slotFingerprint,
    '取值不同却算出同一槽位指纹 —— 去重第二层会把"改主意"误判成"重复"'
  )
})

test('取值的**对象键顺序**不影响 slotFingerprint（稳定序列化）', () => {
  const a = record('preference', claim({ predicate: 'x.y', value: { a: 1, b: 2 } }))
  const b = record('preference', claim({ predicate: 'x.y', value: { b: 2, a: 1 } }))
  expect.equal(slotOfRecord(a)?.slotFingerprint, slotOfRecord(b)?.slotFingerprint)
})

test('Episode 没有槽位指纹（它不是一个事实槽位）', () => {
  expect.equal(slotOfRecord(record('episode', episode())), undefined)
})

// ===========================================================================
// 30. 用户确认的规范化（计划书第 28 / 33 节）
// ===========================================================================

group('用户确认')

test('计划书第 28 节：她的猜测不作为证据（只保留用户那一轮）', () => {
  const herGuess = { kind: 'conversation_event', id: 'cev:c:conv:100' }
  const userAnswer = { kind: 'conversation_event', id: 'cev:c:conv:101' }
  const kept = evidenceExcludingCharacterGuess({
    sourceRefs: [herGuess, userAnswer],
    characterEventIds: ['cev:c:conv:100'],
  })
  expect.equal(kept.length, 1, '她的猜测被当成证据留下了 —— 那会保存两条同级 Memory')
  expect.equal(kept[0].id, userAnswer.id)
})

test('剔除后**什么都不剩**时返回原集合（让契约断言去拒，而不是制造空集）', () => {
  // 空证据会被 assertMemoryEvidence 拒绝，而那时正确的行为是让**它**去拒
  // （它有清晰的错误码），不是在这里制造一个空集然后让下游报含糊的错误
  const onlyHers = [{ kind: 'conversation_event', id: 'cev:c:conv:100' }]
  const kept = evidenceExcludingCharacterGuess({
    sourceRefs: onlyHers,
    characterEventIds: ['cev:c:conv:100'],
  })
  expect.equal(kept.length, 1, '返回空集会掩盖真正的拒绝原因')
})

test('没有她的事件要剔除时原样返回', () => {
  const refs = [
    { kind: 'conversation_event', id: 'cev:c:conv:1' },
    { kind: 'conversation_event', id: 'cev:c:conv:2' },
  ]
  expect.equal(evidenceExcludingCharacterGuess({ sourceRefs: refs, characterEventIds: [] }).length, 2)
})

// ===========================================================================
// 31. Temporal & Provenance（计划书第 34–41 / 85 / 131–132 节，Phase 7）
// ===========================================================================

group('时间语义（validFrom / validUntil / recordedAt）')

test('`validUntil` 的三种状态**必须可区分**（undefined / null / 数字）', () => {
  // 这是 M4 在契约里就区分开的三态，而 SQL 只有一个 NULL ——
  // 因此它在展示层也必须保持可区分，否则那个区分在最后一公里丢掉
  const open = record('preference', claim())
  expect.equal(open.validUntil, null, '新建的当前事实应当是"没有终点"')
  expect.equal(describeValidity(open).state, 'open')

  const ended: MemoryRecord = { ...open, validUntil: T0 + 86400_000 }
  expect.equal(describeValidity(ended).state, 'ended')
  expect.ok(describeValidity(ended).label.includes('→'))

  // undefined（不知道）与 null（没有终点）是**两件事**
  const { validUntil: _drop, ...withoutValidUntil } = open
  void _drop
  expect.equal(describeValidity(withoutValidUntil as MemoryRecord).state, 'unknown')
  expect.notOk(
    describeValidity(withoutValidUntil as MemoryRecord).state ===
      describeValidity(open).state,
    '"不知道何时失效"与"当前有效"被当成了同一件事'
  )
})

test('validFrom / recordedAt 是**两个**时间（计划书第 37 节）', () => {
  // recordedAt = 系统什么时候创建这条 Memory
  // validFrom  = 事实从什么时候开始有效
  // 导入旧对话时二者必然分家（计划书第 30 节的场景一）
  const r = record('preference', claim())
  const withValidFrom: MemoryRecord = { ...r, validFrom: T0 - 30 * 86400_000 }
  const view = describeValidity(withValidFrom)
  expect.equal(view.validFrom, T0 - 30 * 86400_000)
  expect.equal(withValidFrom.recordedAt, T0)
  expect.notOk(view.validFrom === withValidFrom.recordedAt)
})

group('时间线（计划书第 132 节的 WP6 Gate）')

test('时间线按 **recordedAt** 排序（"她依次知道了什么"，不是"事情何时发生"）', () => {
  const early = { ...record('preference', claim({ value: 'like' })), recordedAt: T0 }
  const late = {
    ...record('preference', claim({ value: 'dislike' })),
    recordedAt: T0 + 86400_000,
  }
  const timeline = buildSlotTimeline([late, early])
  expect.equal(timeline.length, 2)
  expect.equal(timeline[0].recordedAt, T0)
  expect.equal(timeline[1].recordedAt, T0 + 86400_000)
})

test('只有 ACTIVE 被标为 current（SUPERSEDED / RETRACTED / DISPUTED 都不是）', () => {
  const mk = (status: MemoryRecord['status']) => ({ ...record('preference', claim()), status })
  expect.equal(buildSlotTimeline([mk('active')])[0].isCurrent, true)
  for (const status of ['superseded', 'retracted', 'disputed'] as const) {
    expect.equal(
      buildSlotTimeline([mk(status)])[0].isCurrent,
      false,
      `${status} 被当成了当前有效状态`
    )
  }
})

test('⚠️ 渲染历史时**两个半边都要在**：历史 + Current', () => {
  // 计划书第 132 节的 Gate 原文：
  //   2026-09-01 喜欢咖啡 / 2026-09-16 戒咖啡 / Current: 戒咖啡
  const older: MemoryRecord = {
    ...record('preference', claim({ predicate: 'food.preference.coffee', value: 'like' })),
    status: 'superseded',
    recordedAt: Date.parse('2026-09-01T00:00:00Z'),
    validUntil: Date.parse('2026-09-16T00:00:00Z'),
    supersededBy: makeMemoryId('char_sumuwei' as never, 'newer'),
  }
  const newer: MemoryRecord = {
    ...record('preference', claim({ predicate: 'food.preference.coffee', value: 'quit' })),
    status: 'active',
    recordedAt: Date.parse('2026-09-16T00:00:00Z'),
    validFrom: Date.parse('2026-09-16T00:00:00Z'),
  }
  const rendered = renderMemoryHistory([older, newer])

  expect.includes(rendered, '2026-09-01', '历史那一条丢失了 —— 那是"覆盖"而不是 supersede')
  expect.includes(rendered, '2026-09-16')
  expect.includes(rendered, '[superseded]')
  expect.includes(rendered, '[active]')
  expect.includes(rendered, 'Current:')
  expect.includes(rendered, 'quit')
  // 历史不因 supersede 而消失
  expect.includes(rendered, 'like')
})

test('没有任何 ACTIVE 时 Current 行**明说**这件事（而不是留空让人推断）', () => {
  const retracted: MemoryRecord = { ...record('preference', claim()), status: 'retracted' }
  const rendered = renderMemoryHistory([retracted])
  expect.includes(rendered, 'Current:')
  expect.includes(rendered, '当前没有有效记忆')
})

test('空槽位渲染成一句明确的话（不是空字符串）', () => {
  const rendered = renderMemoryHistory([])
  expect.includes(rendered, '没有任何记忆')
})

group('证据继承（计划书第 41 节）')

test('派生记忆的根 = 被派生记忆的根的**并集**（不是被派生记忆本身）', () => {
  const a: MemoryRecord = { ...record('preference', claim()), evidenceRootIds: ['cev:c:conv:100'] }
  const b: MemoryRecord = { ...record('preference', claim()), evidenceRootIds: ['cev:c:conv:101'] }
  const roots = inheritedEvidenceRoots([a, b])
  expect.equal(roots.length, 2)
  expect.ok(roots.includes('cev:c:conv:100'))
  expect.ok(roots.includes('cev:c:conv:101'))
  // 关键：根里是**事件**，不是记忆 id
  expect.notOk(roots.some((r) => r.startsWith('mem:')), '把记忆 id 当成了根证据')
})

test('派生链断掉时**抛错**（计划书第 41 节：不能伪造成新的独立证据）', () => {
  const a: MemoryRecord = {
    ...record('preference', claim()),
    evidenceRootIds: ['cev:c:conv:100'],
  }
  let threw = false
  let code = ''
  try {
    assertDerivedEvidenceInherits({
      evidenceRootIds: ['cev:c:conv:200'], // 只带了自己的新证据
      derivedFrom: [a],
      isDerivation: true,
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '派生切断了溯源链 —— M11 的自我强化会从这里开始')
  expect.includes(code, 'derived_evidence_root_missing')
})

test('正确继承时通过', () => {
  const a: MemoryRecord = {
    ...record('preference', claim()),
    evidenceRootIds: ['cev:c:conv:100'],
  }
  assertDerivedEvidenceInherits({
    evidenceRootIds: ['cev:c:conv:100', 'cev:c:conv:200'],
    derivedFrom: [a],
    isDerivation: true,
  })
})

test('非派生记忆不做这条检查（它没有"被派生自"）', () => {
  assertDerivedEvidenceInherits({
    evidenceRootIds: ['cev:c:conv:1'],
    derivedFrom: [],
    isDerivation: false,
  })
})

test('⚠️ 声明是派生却**没给**来源 → 抛错（不静默放行一切）', () => {
  // 空数组会放行一切，于是"忘了传"看起来像"检查通过"
  let threw = false
  let code = ''
  try {
    assertDerivedEvidenceInherits({
      evidenceRootIds: ['cev:c:conv:1'],
      derivedFrom: [],
      isDerivation: true,
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw)
  expect.includes(code, 'derivation_without_source')
})

group('溯源视图')

test('溯源视图给出证据、根、处理器版本与 supersede 关系', () => {
  const r: MemoryRecord = {
    ...record('preference', claim()),
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    supersededBy: makeMemoryId('char_sumuwei' as never, 'x'),
    evidenceRootIds: ['cev:c:conv:1'],
  }
  const view = describeProvenance(r)
  expect.equal(view.processorVersion, 'memory-extractor@1')
  expect.equal(view.evidenceRootIds.length, 1)
  expect.ok(view.sourceRefs.length > 0)
  expect.ok(view.supersededBy !== undefined)
})

// ===========================================================================
// 32. Memory Trace（计划书第 109–110 节，Phase 8）
// ===========================================================================

group('Memory Trace')

test('step kind 与计划书第 109 节的树逐节点对应', () => {
  const declared = declaredMemoryStepKinds()
  // 计划书第 109 节点名的那几个节点
  for (const required of [
    'memory.explicit_intent',
    'memory.job.enqueue',
    'memory.process',
    'evidence.load',
    'candidate.extract',
    'value.evaluate',
    'conflict.check',
    'policy.decide',
    'domain_event.commit',
    'memory.apply',
  ]) {
    expect.ok(declared.includes(required), `计划书第 109 节的节点 ${required} 没有对应的 step kind`)
  }
})

test('属性键是**计数/标签/区间**，没有一个承载正文（计划书第 110 节）', () => {
  /*
   * ⚠️ 判据必须**精确**，否则它自己会给出假信号。
   *
   * 第一版用"键名含 predicate 就算正文"，于是
   * `memory.unregistered_predicate_count` 被误报 —— 而它是一个**计数**，
   * 恰恰是计划书第 19 节要的可观测性。
   *
   * 一条会误报的断言最终会被关掉，于是它什么也守不住。
   * 因此规则改成：**先看后缀**——带 count 后缀的键名允许出现内容类词汇
   * （"有多少个这类东西"不是内容本身），其余一律不允许。
   */
  const countSuffixed = (key: string): boolean =>
    /(_count|\.count)$/.test(key) || /(_ids?|\.ids?)$/.test(key)

  // 这些词一旦出现，键就可能在承载**内容本身**
  const contentWords = ['content', 'text', 'summary', 'utterance']
  // `predicate` 比较特殊：它既可能是"槽位名"（不是私人内容），
  // 也可能是把谓词原文塞进去。因此只允许它在计数/集合后缀下出现。
  const predicateLike = ['predicate', 'qualifier']

  for (const key of declaredMemoryTraceAttributeKeys()) {
    const lower = key.toLowerCase()
    for (const word of contentWords) {
      expect.notOk(
        lower.includes(word),
        `属性键 ${key} 看起来会承载正文（含 "${word}"）—— 计划书第 110 节：不要外发私人 Memory 内容`
      )
    }
    for (const word of predicateLike) {
      expect.notOk(
        lower.includes(word) && !countSuffixed(lower),
        `属性键 ${key} 含 "${word}" 且没有计数/集合后缀 —— 它可能在承载那个值本身`
      )
    }
  }
})

test('⚠️ 隐私守卫：trace 属性里出现 Memory 正文 → **抛错**', () => {
  // 这是"证明没泄漏"，而不是"看来没泄漏"。
  // 将来有人加一个新 step、顺手把 record.content 塞进 attributes 时，
  // 这条断言会拦下他 —— 而那条路径是**外发**的，发出去了就收不回来。
  const record0 = record('preference', claim({ value: 'dislike' }))
  const sensitive = sensitiveTextsOf(record0)

  // 干净属性：通过
  assertNoMemoryContentInTrace({
    attributes: memoryTraceAttributes({
      outcome: {
        candidates: 3,
        valuePassed: 2,
        valueRejected: 1,
        accepted: 2,
        policyRejected: 0,
        deduplicated: 0,
        created: [record0],
        rejections: [],
      },
      processorVersion: 'memory-extractor@1',
      owner: 'character:char_sumuwei',
    }),
    sensitiveTexts: sensitive,
  })

  // 泄漏属性：必须抛
  let threw = false
  let code = ''
  try {
    assertNoMemoryContentInTrace({
      attributes: { note: '她不喜欢香菜', count: 1 },
      sensitiveTexts: ['她不喜欢香菜'],
    })
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }
  expect.ok(threw, '正文泄漏进 trace 却没有报错 —— 它会被外发到 Phoenix')
  expect.includes(code, 'memory_content_in_trace')
})

test('隐私守卫对**短片段**不做判定（会误报的断言会被关掉）', () => {
  // "用户"这种两个字的内容如果参与判定，正常属性（如
  // `memory.owner=character:char_sumuwei`）会被误报 ——
  // 而一条会误报的断言最终会被关掉，于是它什么也守不住
  assertNoMemoryContentInTrace({
    attributes: { 'memory.owner': 'character:char_sumuwei' },
    sensitiveTexts: ['用户', '她'],
    minLength: 4,
  })
})

test('sensitiveTextsOf 覆盖 Claim 与 Episode 的**全部**内容字段', () => {
  // 少一个字段 = 守卫放过那个字段的泄漏。因此这里逐字段断言：
  // 加了新内容字段就必须同步改 sensitiveTextsOf，否则这条会红
  const claimRec = record(
    'preference',
    claim({ predicate: 'food.preference.cilantro', value: 'dislike', qualifiers: { context: 'tech' } })
  )
  const claimTexts = sensitiveTextsOf(claimRec)
  expect.ok(claimTexts.includes('food.preference.cilantro'), 'predicate 没被当作正文')
  expect.ok(claimTexts.includes('dislike'), 'value 没被当作正文')
  expect.ok(claimTexts.includes('tech'), 'qualifiers 的取值没被当作正文')

  const epRec = record('episode', episode({ topicTags: ['memory'] }))
  const epTexts = sensitiveTextsOf(epRec)
  expect.ok(epTexts.includes(epRec.content.kind === 'episode' ? epRec.content.summary : ''))
  expect.ok(epTexts.includes('memory'), 'topicTags 没被当作正文')
})

test('memoryTraceAttributes 产出的键都在**声明清单**里', () => {
  const attributes = memoryTraceAttributes({
    outcome: {
      candidates: 5,
      valuePassed: 3,
      valueRejected: 2,
      accepted: 2,
      policyRejected: 1,
      deduplicated: 1,
      created: [record('preference', claim())],
      rejections: [{ stage: 'conflict', reason: 'marked_disputed', detail: 'x' }],
    },
    processorVersion: 'memory-extractor@1',
    owner: 'character:char_sumuwei',
    fromSequence: 100,
    toSequence: 105,
  })
  const declared = new Set(declaredMemoryTraceAttributeKeys())
  for (const key of Object.keys(attributes)) {
    expect.ok(declared.has(key), `属性 ${key} 没有登记 —— 未登记的键没被审查过，可能是正文`)
  }
  expect.equal(attributes['source.event_range'], '100..105')
  expect.equal(attributes['memory.candidate_count'], 5)
  expect.equal(attributes['memory.disputed_count'], 1)
})

test('计划书第 110 节要求的属性在**有数据时**都会出现', () => {
  const attributes = memoryTraceAttributes({
    outcome: {
      candidates: 2,
      valuePassed: 2,
      valueRejected: 0,
      accepted: 2,
      policyRejected: 0,
      deduplicated: 0,
      created: [
        {
          ...record('preference', claim()),
          authority: 'EXPLICIT_USER_STATEMENT' as const,
          epistemicStatus: 'reported' as const,
        },
      ],
      rejections: [],
    },
    processorVersion: 'memory-extractor@1',
    owner: 'character:char_sumuwei',
    fromSequence: 1,
    toSequence: 3,
  })
  for (const key of [
    'memory.candidate_count',
    'memory.accepted_count',
    'memory.rejected_count',
    'processor.version',
    'source.event_range',
    'memory.owner',
    'memory.type',
    'memory.authority',
  ]) {
    expect.ok(key in attributes, `计划书第 110 节要求的 ${key} 没有出现`)
  }
})

test('pipeline steps 覆盖六个节点，且**没有一个** attributes 含正文', () => {
  const secret = '这是一个绝不该出现在 trace 里的正文片段'
  const steps = memoryPipelineSteps({
    outcome: {
      candidates: 2,
      valuePassed: 1,
      valueRejected: 1,
      accepted: 1,
      policyRejected: 0,
      deduplicated: 0,
      created: [record('preference', claim({ value: secret }))],
      rejections: [{ stage: 'value', reason: 'low_value', detail: secret }],
    },
    processorVersion: 'memory-extractor@1',
    startedAt: T0,
    finishedAt: T0 + 600,
  })

  expect.equal(steps.length, 6)
  for (const step of steps) {
    // 用守卫检查每一步的属性
    assertNoMemoryContentInTrace({ attributes: step.attributes, sensitiveTexts: [secret] })
  }
  // 值闸拒绝数必须出现在 trace 上（"这批有多少被丢"是第一现场）
  const valueStep = steps.find((s) => s.kind === 'value.evaluate')
  expect.equal(valueStep?.attributes.value_rejected, 1)
})

test('显式意图 step 只记**枚举标签**，不记原话', () => {
  const step = explicitIntentStep({
    intentKind: 'remember',
    detectedBy: 'rule',
    startedAt: T0,
  })
  expect.equal(step.kind, 'memory.explicit_intent')
  expect.equal(step.attributes.intent_kind, 'remember')
  expect.equal(step.attributes.detected_by, 'rule')
  // 只有两个属性，且都不是正文
  expect.equal(Object.keys(step.attributes).length, 2)
})

// ===========================================================================
// 33. Memory Admin CLI（计划书第 133–135 / 217 节，Phase 9）
// ===========================================================================

group('Memory Admin CLI')

test('参数解析：npm script 别名与直接 argv 两种写法都认', () => {
  expect.deepEqual(parseMemoryAdminArgs(['--memory-list']), { kind: 'list', limit: 20 })
  expect.equal(parseMemoryAdminArgs(['list']).kind, 'list')
  expect.equal(parseMemoryAdminArgs(['list', '--limit', '50']).kind, 'list')

  const withStatus = parseMemoryAdminArgs(['list', '--status', 'active', '--type', 'preference'])
  expect.equal(withStatus.kind, 'list')
  if (withStatus.kind === 'list') {
    expect.equal(withStatus.status, 'active')
    expect.equal(withStatus.type, 'preference')
  }
})

test('参数解析：get / sources / retract 需要 id，缺了就报用法', () => {
  expect.equal(parseMemoryAdminArgs(['get', 'mem:c:1']).kind, 'get')
  const noId = parseMemoryAdminArgs(['get'])
  expect.equal(noId.kind, 'usage')
  expect.ok(noId.kind === 'usage' && (noId.problem ?? '').includes('<memoryId>'))

  const retract = parseMemoryAdminArgs(['retract', 'mem:c:1', '--reason', '用户要求'])
  expect.equal(retract.kind, 'retract')
  if (retract.kind === 'retract') expect.equal(retract.reason, '用户要求')
})

test('参数解析：history 按 `mem:` 前缀区分 id 与 predicate', () => {
  const byId = parseMemoryAdminArgs(['history', 'mem:char_sumuwei:1'])
  expect.equal(byId.kind === 'history' ? byId.memoryId : undefined, 'mem:char_sumuwei:1')

  const byPredicate = parseMemoryAdminArgs(['history', 'food.preference.cilantro'])
  expect.equal(byPredicate.kind === 'history' ? byPredicate.predicate : undefined, 'food.preference.cilantro')
  // 两者**不混**：一个是 id，一个不是
  expect.equal(byPredicate.kind === 'history' ? byPredicate.memoryId : 'x', undefined)
})

test('参数解析：未知子命令 → 用法 + 原因（不是抛栈）', () => {
  const unknown = parseMemoryAdminArgs(['frobnicate'])
  expect.equal(unknown.kind, 'usage')
  expect.ok(unknown.kind === 'usage' && (unknown.problem ?? '').includes('frobnicate'))
})

test('参数解析：replay 必须给 id 或 --all', () => {
  expect.equal(parseMemoryAdminArgs(['replay']).kind, 'usage')
  expect.equal(parseMemoryAdminArgs(['replay', '--all']).kind, 'replay')
  const all = parseMemoryAdminArgs(['replay', '--all'])
  expect.equal(all.kind === 'replay' ? all.all : false, true)
})

test('用法文本列出了全部子命令，且**点明 M4 不做自动召回**', () => {
  const usage = memoryAdminUsage()
  for (const sub of ['memory:list', 'memory:get', 'memory:history', 'memory:sources', 'memory:stats', 'memory:audit']) {
    expect.includes(usage, sub)
  }
  expect.includes(usage, '写操作')
  expect.includes(usage, 'M5')
})

test('列表渲染：计划书第 135 节要求的字段都在', () => {
  const rendered = renderMemoryList([record('preference', claim())], 'Memory 列表')
  for (const field of ['preference', 'active', 'EXPLICIT_USER_STATEMENT']) {
    expect.includes(rendered, field)
  }
  expect.includes(rendered, 'imp=')
  expect.includes(rendered, 'conf=')
})

test('列表为空时**明说这是正常结果**（而不是让人以为库坏了）', () => {
  // 这条很重要：后台抽取默认关闭，因此"0 条记忆"完全可能是正常的。
  // 一句冷冰冰的"（无）"会让人去排查一个并不存在的故障
  const rendered = renderMemoryList([], 'Memory 列表')
  expect.includes(rendered, '正常结果')
  expect.includes(rendered, 'CHARACTER_MEMORY_BACKGROUND_ENABLED')
  expect.includes(rendered, '记住')
})

test('详情渲染：validUntil 的三态在**展示层**也可区分（计划书第 135 节）', () => {
  const open = renderMemoryDetail(record('preference', claim()))
  expect.includes(open, '没有终点')

  const { validUntil: _d, ...without } = record('preference', claim())
  void _d
  const unknown = renderMemoryDetail(without as MemoryRecord)
  expect.includes(unknown, '(不知道)')
  expect.notOk(
    unknown.includes('没有终点'),
    '"不知道何时失效"被渲染成了"当前有效" —— 三态在最后一公里丢掉了'
  )
})

test('溯源渲染：查不到证据事件时**显式报警**（来源存疑）', () => {
  const r = record('preference', claim())
  const rendered = renderMemorySources(r, [])
  expect.includes(rendered, '⚠️')
  expect.includes(rendered, '来源存疑')
})

test('溯源渲染：找得到时打出序号、说话人与原文', () => {
  const r = record('preference', claim())
  const evidenceId = r.sourceRefs[0].id
  const rendered = renderMemorySources(r, [
    {
      id: evidenceId,
      sequence: 42,
      actorType: 'user',
      content: '我不吃香菜',
      createdAt: T0,
    },
  ])
  expect.includes(rendered, '#42')
  expect.includes(rendered, '[user]')
  expect.includes(rendered, '我不吃香菜')
  expect.includes(rendered, '[根证据]')
})

test('统计渲染：两个"目标为 0"的项**显式标出**目标值', () => {
  const rendered = renderMemoryStats({
    total: 3,
    active: 2,
    superseded: 1,
    retracted: 0,
    disputed: 0,
    byProcessor: [{ processor: 'memory-extractor', version: 'memory-extractor@1', count: 3 }],
    unsupported: 0,
    contaminated: 0,
    unregisteredPredicate: 0,
  })
  expect.includes(rendered, '目标为 **0**')
  expect.includes(rendered, 'unsupported')
  expect.includes(rendered, 'contaminated')
  expect.includes(rendered, '✅')
})

test('统计渲染：非 0 时标成"需要排查"（而不是照旧打勾）', () => {
  const rendered = renderMemoryStats({
    total: 1,
    active: 1,
    superseded: 0,
    retracted: 0,
    disputed: 0,
    byProcessor: [],
    unsupported: 1,
    contaminated: 0,
    unregisteredPredicate: 0,
  })
  expect.includes(rendered, '需要排查')
})

test('审计清单把**八个问题**逐条写出来（计划书第 217 节）', () => {
  const rendered = renderMemoryAudit([record('preference', claim())])
  for (const question of [
    '真的值得记吗',
    '来源正确吗',
    '谁说的',
    '是不是模型猜的',
    '当前还有效吗',
    '有没有重复',
    '旧版本在哪里',
    '为什么建立',
  ]) {
    expect.includes(rendered, question)
  }
})

test('审计清单为空时**如实说明规模不足**（不用假数据凑）', () => {
  // 计划书第 217 节要求"至少数十条"。真实库现在只有个位数 ——
  // 那是如实状态，不应当用沙箱数据冒充真实库的审计对象
  const rendered = renderMemoryAudit([])
  expect.includes(rendered, '数十条')
  expect.includes(rendered, '如实')
})

// ===========================================================================
// 汇总
// ===========================================================================

// ===========================================================================
// 34. 只读调用的分类（一个实测缺陷的回归锁）
// ===========================================================================
group('只读调用分类（CLI）')

/*
 * ===========================================================================
 *  ⚠️ 这一组守的是一个**实测到的操作性缺陷**
 * ===========================================================================
 * `preflight()` 会真的发一次 `/chat/completions` 探测连通性，而它挡在
 * `memory:*` 这些**纯本地只读**命令前面。实测：
 *
 *     pnpm memory:audit
 *     → 模型连通性检查失败 (HTTP 522)
 *
 * 而那条命令读的是本地 `memory_records` 表，一次模型都不调。
 * 后果不是"慢一点"，而是**在最需要审计的时候审计不了**。
 *
 * ---------------------------------------------------------------------------
 *  为什么这条规则被抽成 `src/invocation.ts` 的一个纯函数
 * ---------------------------------------------------------------------------
 * 它原本是 `main.ts` 里的一行布尔表达式。而 `main.ts` 在模块加载时
 * **无条件执行 `main()`**，因此不能被任何测试导入 ——
 * 留在那一行里的规则永远不会有机器证据。
 *
 * 抽出来之后，下面两条断言才可能：
 *   ① 每个 `memory:*` npm 脚本都必须被判为只读
 *      （以后新增子命令而忘了登记 → 这里红）
 *   ② 普通对话调用**不能**被判为只读
 *      （否则 preflight 的"尽早炸掉"就失效了）
 */

test('每个 `memory:*` npm 脚本都必须被判为只读（否则审计会被模型故障挡住）', () => {
  // 从 package.json **读**，而不是手抄一份清单：
  // 手抄的清单会与 scripts 漂移，而漂移方向总是"新命令没被登记"。
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> }

  const memoryScripts = Object.entries(pkg.scripts).filter(([name]) =>
    name.startsWith('memory:')
  )
  expect.ok(memoryScripts.length > 0, '应当至少有一个 memory:* 脚本')

  const missed: string[] = []
  for (const [name, command] of memoryScripts) {
    // 把脚本命令里的参数抽出来当作 argv（跳过 `tsx src/main.ts` 那一段）
    const argv = command.split(/\s+/).filter((token) => token.startsWith('--'))
    if (!isReadOnlyInvocation(argv)) missed.push(`${name} → ${command}`)
  }

  expect.equal(
    missed.length,
    0,
    `以下 memory:* 脚本没有被判为只读，它们的审计会被模型故障挡住：\n  ${missed.join('\n  ')}`
  )
})

test('每个 `story:*` npm 脚本也必须被判为只读（S8 入口与 memory:* 同一条理由）', () => {
  /*
   * ⚠️ 与上一条同型、同理由：`memory:*` 与 `story:*` 都是"最需要在模型服务抖动时也能用"的入口。
   *    `--story-start`（`ADR-107` `R-2a′`）与 `--story-withdraw`（`R-4`）都是**写操作**，
   *    但都**不需要探测模型连通性** —— `src/invocation.ts` 的 `READ_ONLY_FLAGS`
   *    回答的是"要不要发那次网络探测"，**不是**"这个命令只读"（模块头 `:36-40`）。
   * ⚠️ 判据取自 `package.json` 而不是手抄清单：手抄会漂移，而漂移方向总是"新命令没被登记"。
   */
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> }
  const storyScripts = Object.entries(pkg.scripts).filter(([name]) =>
    name.startsWith('story:')
  )
  expect.ok(storyScripts.length > 0, '应当至少有一个 story:* 脚本')

  const missed: string[] = []
  for (const [name, command] of storyScripts) {
    const argv = command.split(/\s+/).filter((token) => token.startsWith('--'))
    if (!isReadOnlyInvocation(argv)) missed.push(`${name} → ${command}`)
  }
  expect.equal(
    missed.length,
    0,
    `以下 story:* 脚本没有被判为只读，它们会被模型连通性探测挡住：\n  ${missed.join('\n  ')}`
  )
})

test('普通对话调用**不能**被判为只读（否则 preflight 的尽早炸掉会失效）', () => {
  // 没有任何只读标志 → 必须探测连通性
  expect.equal(isReadOnlyInvocation([]), false)
  expect.equal(isReadOnlyInvocation(['Alex']), false)
  expect.equal(isReadOnlyInvocation(['--test']), false)
  expect.equal(isReadOnlyInvocation(['--reset']), false)
  // 只读标志 → 不探测
  expect.equal(isReadOnlyInvocation(['--memory-audit']), true)
  expect.equal(isReadOnlyInvocation(['--kernel-status']), true)
  expect.equal(isReadOnlyInvocation(['--seed-status']), true)
  expect.equal(isReadOnlyInvocation(['--inspect']), true)
  /*
   * M5.1 WP2：开发者查询面（`--dev-server`）。
   *
   * 与上面几条同一条理由，而且更强：那条路径**从来不调模型**，
   * 它把既有的只读视图（trace / memory 诊断 / 执行账本）用 HTTP 摊开。
   * 服务商抖动时正是最想查的时候 —— 那时它更不该被连通性探测挡住。
   */
  expect.equal(isReadOnlyInvocation(['--dev-server']), true)
  expect.equal(isReadOnlyInvocation(['--dev-server', '--port', '8787']), true)
  // 位置参数形式的 memory 子命令（`pnpm memory:list` 之外的调用方式）
  expect.equal(isReadOnlyInvocation(['memory', 'list']), true)
  // 只读命令带额外参数时仍然只读
  expect.equal(isReadOnlyInvocation(['--memory-list', '--status', 'active']), true)
})

test('只读清单本身有说明，且 `--migrate` 被**单独**交代（不混进清单）', () => {
  const text = describeReadOnlyInvocation()

  // 清单本身可读：每个只读标志都在说明里
  expect.includes(text, '--memory-audit')
  expect.includes(text, '--kernel-status')
  expect.includes(text, '--seed-status')

  /*
   * ⚠️ `--migrate` **会**出现在说明里 —— 而且是刻意的。
   *
   * 第一版这条断言写的是 `notIncludes(text, '--migrate')`，它失败了 ——
   * 而失败得对：说明文本的作用正是讲清"migrate 走另一条更早的分支"，
   * 不提它反而会让读者以为 migrate 也需要连通性。
   *
   * 真正要断言的性质是"migrate 不在**清单**里"（由下面的
   * `isReadOnlyInvocation(['--migrate']) === false` 守住），
   * 以及"说明把它与清单**分开**讲"。
   */
  expect.includes(text, '--migrate')
  expect.includes(text, '更早')
  expect.includes(text, '连 Key 都不需要')

  // 它不在只读清单里：migrate 有自己的更早分支
  expect.equal(isReadOnlyInvocation(['--migrate']), false)
})

// ===========================================================================
// 35. 生产装配接线（本次缺陷类别的回归锁）
// ===========================================================================
group('生产装配接线（回归锁）')

/*
 * ===========================================================================
 *  ⚠️ 这一组守的是**两次真实的接线缺口**
 * ===========================================================================
 * 真库实测（修复前）：
 *
 *     $ tsx src/main.ts "记住，我现在上的大学是示例工程科技大学"
 *     苏沐薇: 记住了。示科。……
 *     $ pnpm memory:list
 *     （没有匹配的记忆）
 *
 * 根因不是某段逻辑写错，而是**生产装配里两处该接的线没接**：
 *
 *   ① `createExplicitMemoryService` 在全仓库**没有任何调用点**
 *      —— 服务完整实现、`m4:verify` §13 全绿，但对话链路从不调它
 *   ② `buildKernel` **没有传** `registry: createFullDomainEventRegistry()`
 *      —— 于是生产内核只有 M2.5 的最小诊断集，`MEMORY_*` 六种领域事件
 *        一个都没登记，每一条记忆提案都在放行口被拒
 *        （拒绝码 `domain_event_type_unregistered`，靠 trace 才查出来）
 *
 * 两次都是同一个形状：**设计意图写在注释里、实现在代码里，
 * 而中间的接线没人做，且没有任何测试在管"生产装配是否接上了"**。
 *
 * m4:verify / eval:m4 之所以抓不到：它们**自己**传了 registry、
 * **自己**调用服务。它们测的是"这些部件能工作"，
 * 而缺陷在"它们被装到一起了吗"。
 *
 * 因此这里直接检查 `src/main.ts` 的装配代码。
 *
 * ---------------------------------------------------------------------------
 *  为什么用源码断言（而不是跑一次 main）
 * ---------------------------------------------------------------------------
 * `main.ts` 在模块加载时会**无条件执行 `main()`**，因此不能被测试导入
 * （见 `src/invocation.ts` 的同一段说明）。而这两个缺口的全部内容
 * 就是"那一行有没有写" —— 源码断言恰好是最直接的判据。
 *
 * 这个项目已有同类做法：`m3.5:verify` 逐条抓取
 * `update conversation_events` 的语句体来断言 append-only 未被侵蚀。
 * 用源码断言守"装配接线"与那一条是同一个思路：
 * **当被守的东西本身就是"代码里有没有那一行"时，源码就是最合适的判据。**
 */

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

test('⚠️ 回归：`buildKernel` 必须传 `createFullDomainEventRegistry()`', () => {
  /*
   * 不传的后果是**每一条记忆提案都被拒**，而拒绝码
   * `domain_event_type_unregistered` 只在 trace 里，
   * 命令行上只看到"她没记住"。
   */
  expect.includes(
    mainSource,
    'registry: createFullDomainEventRegistry()',
    'main.ts 的 buildKernel 必须传入全集 registry —— ' +
      '否则 MEMORY_* 领域事件没有登记，生产里每条记忆提案都会在放行口被拒'
  )
})

test('⚠️ 回归：`TurnGateway` 必须被注入 `memoryWriter`', () => {
  /*
   * 不注入的后果：`createExplicitMemoryService` 成了**死代码**，
   * 用户说"记住，……"只会得到一句礼貌的"记住了"，而库里一条都没有。
   */
  expect.includes(
    mainSource,
    'memoryWriter:',
    'main.ts 必须把显式记忆端口注入 TurnGateway —— ' +
      '否则显式路径是死代码，而她会声称记住了'
  )
  expect.includes(
    mainSource,
    'memoryExplicitEnabled:',
    '开关必须真的被用来 gate 行为，而不只是被读进日志'
  )
})

test('⚠️ 回归：`buildMemoryWriter` 必须接线 `recentExplicitWrites`（B① / ADR-058）', () => {
  /*
   * 与 ①② 同一个形状的接线缺口：ADR-058 的兜底纯函数完整、有 L1 锁，
   * 但"生产里有没有人喂它'会话内最近写入'"是**另一件事**。
   * 不接的后果：`correctViaRecentWrite` 在生产里永远走不到 ——
   * 「更正一下，我换成 Mac 了」继续 target_not_found，而离线复现器（接了线）
   * 却是绿的 ⇒ 出现"门里绿、生产里坏"的假绿，正是本组存在要防的那一类。
   *
   * 判据两条（都能失败）：端口名出现 + 用的是共享实现（不是手抄一份查询）。
   */
  expect.includes(
    mainSource,
    'recentExplicitWrites:',
    'main.ts 的 buildMemoryWriter 必须把 recentExplicitWrites 接进显式记忆服务 —— ' +
      '否则 B① 目标层兜底在生产里是死代码（离线复现器接了线，会给出假绿）'
  )
  expect.includes(
    mainSource,
    'listRecentExplicitWrites',
    '端口必须复用 memory-store 的 listRecentExplicitWrites（与复现器同一实现）—— ' +
      '手抄一份查询等于造第二个判据'
  )
})

test('⚠️ 回归：只读网关（--dump-prompt）**不能**注入写路径', () => {
  /*
   * `--dump-prompt` 复用同一条编译路径，但它的契约是"只有读"。
   * 注入 memoryWriter 会让它写库 —— 而那正是它存在要避免的事。
   *
   * ⚠️ 判据是**结构**（正则跨空白），不是逐字符的字面量。
   *    第一版写的是源码里的原样文本（含缩进），于是它**报错了**
   *    —— 报得对：它守的本来是"dryRun 分支不注入写路径"这个结构，
   *    却写成"这几个字符必须连在一起"。前者是契约，后者是排版。
   *    一个会因为重新缩进而失败、却不会因为**真的注入了写路径**
   *    而失败的断言，是反向的。
   */
  const guarded = /\.\.\.\(options\.dryRun\s*\?\s*\{\}\s*:\s*\{[\s\S]*?memoryWriter[\s\S]*?\}\)/.test(
    mainSource
  )
  expect.ok(
    guarded,
    '只读网关必须用 `...(options.dryRun ? {} : { memoryWriter: ... })` 显式排除写路径'
  )
})

test('⚠️ 回归：进入对话前**必须**补折叠未折叠的 Memory 领域事件（S3-3）', () => {
  /*
   * ===========================================================================
   *  为什么这条也归"生产装配接线"这一组
   * ===========================================================================
   * 它与 ①② 是**同一个形状**：`recoverMemoryProjections()` 实现完整、
   * 有自己的测试（`m4:hardkill` §3d 用确定性注入验它），
   * 但"它有没有被接到启动路径上"是**另一件事**。
   *
   * 不接的后果（M4 验收实测）：强杀/崩溃会留下"领域事件已提交、
   * 投影未折叠"的孤儿 —— 事实没丢（在账本里），但她**暂时想不起来**，
   * 而且这件事**不会自愈**。`m4:hardkill` 实测复现过。
   *
   * ---------------------------------------------------------------------------
   *  判据为什么是"位置"而不只是"出现了"
   * ---------------------------------------------------------------------------
   * 只断言"源码里有这个调用"是不够的：把它放在只读分支**之前**，
   * 会让 `memory:audit` / `--kernel-status` 这些承诺只读的命令**写库** ——
   * 那是一个比原缺口更糟的回归（审计动作会污染它正在审计的库）。
   *
   * 因此这里断言三件事（都能失败）：
   *   ① 调用存在，且在 `!dryRun` 守卫里（`--test`/`--dry-run` 的承诺是"不写库"）
   *   ② 它在**全部只读分支之后** —— 那些分支各自 `return`，先返回就不会走到它
   *   ③ 只读分支确实还在（否则 ② 是恒真的：删掉分支也能"通过"）
   */
  const callIndex = mainSource.indexOf('await recoverMemoryProjections(')
  expect.ok(
    callIndex > 0,
    'main.ts 必须在进入对话前调用 recoverMemoryProjections —— ' +
      '否则崩溃留下的"已提交未折叠"事件永远不会被补上（S3-3）'
  )

  expect.ok(
    /if\s*\(!dryRun\)\s*\{[\s\S]*?await recoverMemoryProjections\(/.test(mainSource),
    '补折叠必须在 `!dryRun` 守卫里 —— `--test`/`--dry-run` 的承诺是不写库'
  )

  // 只读分支必须**仍然存在**，且都在补折叠之前 return
  const readOnlyAnchors = [
    'runMemoryAdminCommand(',
    'renderKernelStatus(',
    'renderSeedStatus(',
    'renderPromptDump(',
    'renderInspector(',
  ]
  for (const anchor of readOnlyAnchors) {
    const anchorIndex = mainSource.indexOf(anchor)
    expect.ok(anchorIndex > 0, `只读分支 ${anchor} 必须仍然存在（否则下面的顺序断言是恒真的）`)
    expect.ok(
      anchorIndex < callIndex,
      `补折叠必须在只读分支 ${anchor} **之后** —— ` +
        '否则承诺只读的命令（memory:* / --kernel-status / --seed-status / --inspect / --dump-prompt）会写库'
    )
  }
})

test('⚠️ 回归：M4.1 的 memory 开关必须是**真的**（不能又是一个惰性开关）', () => {
  /*
   * ===========================================================================
   *  这一条守着 D3 那一类缺陷
   * ===========================================================================
   * `CHARACTER_MEMORY_BACKGROUND_ENABLED` 的教训不是"后台抽取没做"，
   * 而是：**一个被读进 flags、被打印出来、看起来能开的开关，
   * 实际上没有任何消费者**。实测打开它跑两轮普通陈述，产出 0 条记忆。
   *
   * 于是 M4.1 新增的 `memoryLlmExtractorEnabled` 必须同时满足两件事：
   *   ① 它真的被 `main.ts` 消费（决定用哪个抽取器）
   *   ② 它消费的方式**真的改变行为**（出现 ChainedContentExtractor）
   *
   * 只断言"flag 存在"是不够的 —— 那正是 D3 里那个开关也满足的条件。
   */
  const flagsSource = readFileSync(
    new URL('../src/kernel/app/flags.ts', import.meta.url),
    'utf8'
  )

  expect.includes(
    flagsSource,
    'memoryLlmExtractorEnabled',
    'flags 里必须有 memoryLlmExtractorEnabled（D2-A 的开关）'
  )
  expect.includes(
    mainSource,
    'memoryLlmExtractorEnabled',
    'main.ts 必须消费 memoryLlmExtractorEnabled —— 否则它就是一个惰性开关（D3 的形状）'
  )
  expect.includes(
    mainSource,
    'ChainedContentExtractor',
    'main.ts 必须用 ChainedContentExtractor 实现"规则 → 模型兜底"，' +
      '而不是把 flag 读进来只用于日志'
  )
  expect.includes(
    mainSource,
    'LlmContentExtractor',
    'main.ts 必须真的装上 LLM 抽取器，否则打开开关什么也不会变'
  )

  /*
   * 反向：`memory-background` 至今**没有**消费者，而它必须**如实自称如此**。
   *
   * 断言"它仍然没有被接线"是刻意的：将来谁真的补上接线，
   * 这条会红 —— 而那时他必须**同时**去掉 NOT-WIRED 标签、
   * 改文档、并更新这条断言。这正是我们要的"接线与声明不能各走各的"。
   */
  expect.includes(
    flagsSource,
    'memory-background(NOT-WIRED)',
    '在 flags 行上必须如实标出后台抽取**未接线**（否则下一个人会以为它能开）'
  )
  expect.includes(
    mainSource,
    '没有接到任何东西',
    'main.ts 必须在开关被打开时打印"它没有接到任何东西"的告警'
  )
  /*
   * ⚠️ 判据必须是"**真的 import 了**"，而不是"出现了 `memory/job` 这几个字"。
   *    第一版写成 `mainSource.includes('memory/job')`，然后它**红了** ——
   *    因为上面那条告警的**注释里**就写着这个路径。
   *    一条会因为注释提到某个路径而失败的断言，测的是措辞而不是接线。
   */
  const importsMemoryJob = /from\s+['"][^'"]*memory\/job[^'"]*['"]/.test(mainSource)
  expect.notOk(
    importsMemoryJob,
    'main.ts 竟然开始 import memory/job 了 —— 那么 D3 已接线：' +
      '请同时去掉 NOT-WIRED 标签、更新 memory-lifecycle.md，并改掉这条断言'
  )
})

test('⚠️ 回归：只有用户事件才可能触发显式记忆', () => {  // 她自己的话永远不能被解读成"用户要求记住" —— M4 反污染的入口闸
  const explicitTurn = readFileSync(
    new URL('../src/kernel/app/memory/explicit-turn.ts', import.meta.url),
    'utf8'
  )
  expect.includes(
    explicitTurn,
    "if (request.event.actorType !== 'user') return undefined",
    '非用户事件必须直接跳过显式记忆处理'
  )
})

// ===========================================================================
// 36. 槽位的记忆类型（一次真实的错类型）
// ===========================================================================
group('槽位的记忆类型')

test('⚠️ 回归：每个规则都必须声明 memoryType（不许写死 preference）', () => {
  /*
   * 真库实测：`记住，我现在上的大学是示例工程科技大学` 被记成
   * **preference**（应为 person_fact）。
   *
   * 而 `type` 参与 `canonicalKey`，所以同一件事实经规则抽取
   * 与经模型抽取会落到**两个槽位**，去重层认不出它们是一件事 ——
   * 与 `food.avoid.general` 那次是同一个形状。
   */
  const source = readFileSync(
    new URL('../src/kernel/app/memory/content-extractor.ts', import.meta.url),
    'utf8'
  )
  // `type: 'preference'` 的写死必须消失（它现在应当读 rule.memoryType）
  expect.notIncludes(
    source,
    "return {\n        type: 'preference',",
    '抽取结果不能写死 preference —— 类型必须来自规则'
  )
  expect.includes(source, 'type: rule.memoryType')
})

test('机构名是 person_fact（不是 preference），且值里没有前导系词', async () => {
  const extractor = createRuleOnlyContentExtractor()
  const extracted = await extractor.extract({
    text: '我现在上的大学是示例工程科技大学',
    owner: entityRef('character', 'probe'),
    speaker: entityRef('user', 'probe'),
  })

  expect.ok(extracted !== undefined, '应当抽出内容')
  expect.equal(extracted!.type, 'person_fact', '机构名属于身份事实，不是偏好')
  const content = extracted!.content as { predicate?: string; value?: unknown }
  expect.equal(content.predicate, 'education.institution')
  expect.equal(
    content.value,
    '示例工程科技大学',
    '值里不能带前导系词 —— "是示例工程科技大学"会让 canonicalKey 与正确写法不同'
  )
})

test('偏好类槽位仍然是 preference（没有一律改成 person_fact）', async () => {
  const extractor = createRuleOnlyContentExtractor()
  const extracted = await extractor.extract({
    text: '我不吃香菜',
    owner: entityRef('character', 'probe'),
    speaker: entityRef('user', 'probe'),
  })
  expect.equal(extracted?.type, 'preference')
})

test('⚠️ 回归：抽审 ⑤ 的答案必须与 status 自洽（不能"已撤回但当前有效"）', () => {
  /*
   * 真库实测的误导输出：
   *
   *     ⑤ 当前还有效吗？  → status = retracted, validity = 当前有效
   *
   * 两半互相矛盾，而读它的人正在回答"这条还算不算数"。
   * 根因是那行只用**有效期窗口**回答，忽略 `status` ——
   * 而被撤回的记忆窗口是开放的（它是被撤回的，不是被时间终止的）。
   *
   * 抽审的全部价值就在这八个问题能被人信任：
   * 一个**自相矛盾**的答案比没有答案更糟，因为它会让人以为
   * 是自己看错了，而不是让系统看起来有问题。
   */
  const base = {
    id: 'mem:probe:x' as never,
    owner: entityRef('character', 'probe'),
    type: 'person_fact' as const,
    content: {
      kind: 'claim' as const,
      subject: entityRef('user', 'probe'),
      predicate: 'education.institution',
      value: '某大学',
    },
    subjects: [entityRef('user', 'probe')],
    epistemicStatus: 'reported' as const,
    authority: 'EXPLICIT_USER_STATEMENT' as const,
    importance: 0.8,
    confidence: 0.9,
    processor: 'probe',
    processorVersion: 'probe@1',
    sourceRefs: [],
    evidenceRootIds: [],
    recordedAt: 1_800_000_000_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    revision: 1,
    reducerVersion: MEMORY_REDUCER_VERSION,
    schemaVersion: 5,
    contentFingerprint: 'probe',
    // 被撤回的记忆：窗口是**开放**的（它不是被时间终止的）
    validUntil: null,
  }

  const active = renderMemoryAudit([{ ...base, status: 'active' } as never])
  const retracted = renderMemoryAudit([{ ...base, status: 'retracted' } as never])

  const activeLine = active.split('\n').find((l) => l.includes('⑤')) ?? ''
  const retractedLine = retracted.split('\n').find((l) => l.includes('⑤')) ?? ''

  expect.includes(activeLine, '当前有效')
  expect.includes(retractedLine, '已撤回')
  // 关键断言：撤回的那条**不能**同时说"当前有效"
  expect.notIncludes(
    retractedLine,
    '当前有效',
    '被撤回的记忆不能又被说成"当前有效" —— 那是自相矛盾的答案'
  )

  /*
   * S4-1（2026-09-26）：⑤ 的撤回文案必须按 reason 区分；
   * 不知道原因时**不得**断言"用户要求忘掉"（真库那条因缺陷修复被撤回的记录
   * 曾被渲染成用户 forget 请求）。三个正控 + 一个负控。
   */
  const line5 = (out: string): string => out.split('\n').find((l) => l.includes('⑤')) ?? ''
  const forget = renderMemoryAudit([{ ...base, status: 'retracted' } as never], new Map([[String(base.id), 'explicit_forget']]))
  const correction = renderMemoryAudit([{ ...base, status: 'retracted' } as never], new Map([[String(base.id), 'explicit_correction']]))
  const auditRetract = renderMemoryAudit([{ ...base, status: 'retracted' } as never], new Map([[String(base.id), 'audit']]))

  expect.includes(line5(forget), '用户要求忘掉', 'explicit_forget 的文案必须明说用户要求忘掉')
  expect.includes(line5(correction), '记错', 'explicit_correction 的文案必须明说是更正撤回')
  expect.includes(line5(auditRetract), '审计', 'audit 的文案必须明说是系统审计撤回')
  // 负控：不传 reasons ⇒ 如实说"未提供"，不得冒充用户 forget
  expect.notIncludes(
    retractedLine,
    '用户要求忘掉',
    '不知道撤回原因时断言"用户要求忘掉"是 M4 S4-1 登记过的误导形态'
  )
  expect.includes(
    retractedLine,
    '原因未提供',
    '不知道原因时必须如实写"原因未提供"并指向 memory:history / memory:sources'
  )
})

const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M4 领域模型测试（WP1 Gate）')
process.exit(summary.failed === 0 ? 0 : 1)
