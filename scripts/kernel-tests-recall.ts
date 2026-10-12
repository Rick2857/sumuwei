/**
 * M5 WP1 —— **Recall 契约测试**（`pnpm m5:test`）。
 *
 * ============================================================================
 *  它测的是"契约能不能挡住它该挡住的东西"
 * ============================================================================
 * 计划书 WP1 的 Done 是四件事：
 *
 *     contracts：compile · validate · serialize · deserialize 全部通过
 *
 * 因此这里**没有**数据库、没有模型、没有检索实现 —— deterministic、毫秒级。
 * 它比"类型能编译"多做三件这一层才做得到的事：
 *
 *   ① **拒绝死枚举值**：每个 `RecallExclusionReason` 都必须登记"谁产出它"；
 *      今天没有生产者的（`DELETED` / `NOT_ACTIVE`）必须被标成保留位，
 *      且运行期不许拿它们当真实理由。
 *      （本项目最贵的缺陷形状之一就是"看起来能表达、永远触发不了"的值。）
 *   ② **与 M4 不重复定义资格**：`exclusionReasonForStatus` 必须与
 *      `isRecallEligible` 逐状态一致 —— 两处定义漂移的表现是
 *      "她想起了不该想起的事"，而那种错不会报错。
 *   ③ **隐私在契约层锁住**：进 trace 的形态里有 id / 指纹 / 计数，
 *      **一个字正文都没有**。
 *
 * 跑法：pnpm m5:test        （可加过滤词：pnpm m5:test 保留位）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'
import {
  MEMORY_STATUSES,
  isRecallEligible,
  type MemoryStatus,
  type EvidenceRef,
} from '../src/kernel/contracts/memory.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  RECALL_CHANNELS,
  RECALL_EXCLUSION_REASONS,
  RECALL_EXCLUSION_REASON_FACTS,
  RECALL_INTENTS,
  RECALL_LIMITS,
  RECALL_SCHEMA_VERSION,
  RESERVED_EXCLUSION_REASONS,
  assertContextBundle,
  assertExclusionReasonReachable,
  assertRecallDecision,
  createEmptyContextBundle,
  createRecallRequest,
  describeExclusionReason,
  describeRecallCandidate,
  exclusionReasonForStatus,
  isRecallChannel,
  isRecallExclusionReason,
  isRecallIntent,
  parseRecallRequest,
  recallRequestDigest,
  serializeContextBundleForTrace,
  serializeRecallRequest,
  type ContextBundle,
  type RecallCandidate,
  type RecallDecision,
  type RecallRequest,
} from '../src/kernel/contracts/recall.ts'

const NOW = 1_800_000_000_000

function request(
  overrides: Partial<Parameters<typeof createRecallRequest>[0]> = {}
): RecallRequest {
  return createRecallRequest({
    traceId: 'trace:wp1',
    characterId: 'char_sumuwei',
    user: entityRef('user', 'user-alex'),
    query: { text: '你还记得我在哪所大学吗？' },
    ...overrides,
  })
}

function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    memoryId: 'mem:char_sumuwei:person_fact-abc' as RecallCandidate['memoryId'],
    owner: entityRef('character', 'char_sumuwei'),
    type: 'person_fact',
    status: 'active',
    authority: 'EXPLICIT_USER_STATEMENT',
    epistemicStatus: 'reported',
    subjects: [entityRef('user', 'user-alex')],
    importance: 0.8,
    confidence: 0.9,
    recordedAt: NOW,
    contentFingerprint: 'fp-abc',
    searchable: 'education.institution 示例工程科技大学',
    dataText: '她在示例工程科技大学就读',
    sourceRefs: [{ kind: 'conversation_event', id: 'cev:1' } as EvidenceRef],
    retrievedBy: ['subject', 'lexical'],
    integrityOk: true,
    ...overrides,
  }
}

function selectedMemory(from: RecallCandidate = candidate()) {
  return {
    memoryId: from.memoryId,
    dataText: from.dataText,
    type: from.type,
    authority: from.authority,
    epistemicStatus: from.epistemicStatus,
    subjects: from.subjects,
    sourceRefs: from.sourceRefs,
    contentFingerprint: from.contentFingerprint,
    recordedAt: from.recordedAt,
    estimatedTokens: 12,
  }
}

function bundleOf(input: {
  request?: RecallRequest
  candidates?: RecallCandidate[]
  decisions?: RecallDecision[]
  selected?: ReturnType<typeof selectedMemory>[]
}): ContextBundle {
  const req = input.request ?? request()
  const selected = input.selected ?? []
  return {
    traceId: req.traceId,
    characterId: req.characterId,
    user: req.user,
    generatedAt: NOW,
    request: req,
    candidates: input.candidates ?? [],
    decisions: input.decisions ?? [],
    selected,
    budget: {
      budgetTokens: req.contextBudget.memoryTokens,
      memoryTokens: selected.reduce((sum, item) => sum + item.estimatedTokens, 0),
      reservedTokens: req.contextBudget.reservedTokens ?? 0,
      totalTokens: selected.reduce((sum, item) => sum + item.estimatedTokens, 0),
    },
    externalEvidence: [],
    integrityNotices: [],
  }
}

// ===========================================================================
group('契约形状（计划书 WP1 Required Contracts）')
// ===========================================================================

test('五个要求的契约都存在，且 schema 版本已声明', async () => {
  // 类型层面已由 tsc 保证"存在"；这里锁住的是**运行期可用的常量与函数**
  expect.equal(RECALL_SCHEMA_VERSION, 1)
  expect.equal(typeof createRecallRequest, 'function')
  expect.equal(typeof parseRecallRequest, 'function')
  expect.equal(typeof serializeRecallRequest, 'function')
  expect.equal(typeof assertRecallDecision, 'function')
  expect.equal(typeof assertContextBundle, 'function')
  expect.equal(typeof createEmptyContextBundle, 'function')
})

test('RecallExclusionReason 覆盖计划书点名的九种语义（外加预算一种）', () => {
  for (const required of [
    'WRONG_USER',
    'INVALID_TARGET',
    'FORGOTTEN',
    'DELETED',
    'SUPERSEDED',
    'NOT_ACTIVE',
    'LOW_RELEVANCE',
    'DUPLICATE',
    'POLICY',
  ]) {
    expect.ok(
      (RECALL_EXCLUSION_REASONS as readonly string[]).includes(required),
      `计划书要求的 ${required} 必须存在`
    )
  }
  // 用户 2026-09-17 裁定：证据缺失必须与"删除"分开
  expect.ok(
    (RECALL_EXCLUSION_REASONS as readonly string[]).includes('ORPHANED_EVIDENCE'),
    'ORPHANED_EVIDENCE 必须存在（它与 DELETED 是两个语义）'
  )
  // 预算被挤掉需要自己的理由，否则只能伪装成 POLICY
  expect.ok(
    (RECALL_EXCLUSION_REASONS as readonly string[]).includes('BUDGET_EXHAUSTED'),
    'BUDGET_EXHAUSTED 必须存在（WP5 的生产者）'
  )
  expect.equal(isRecallExclusionReason('WRONG_USER'), true)
  expect.equal(isRecallExclusionReason('NOT_A_REASON'), false)
})

// ===========================================================================
group('拒绝死枚举值（本文件最重要的两条）')
// ===========================================================================

test('每个理由都在登记表里，且登记表没有多余项', () => {
  for (const reason of RECALL_EXCLUSION_REASONS) {
    expect.ok(
      RECALL_EXCLUSION_REASON_FACTS[reason] !== undefined,
      `${reason} 必须在 RECALL_EXCLUSION_REASON_FACTS 里登记（谁产出它）`
    )
  }
  const registered = Object.keys(RECALL_EXCLUSION_REASON_FACTS)
  expect.equal(
    registered.length,
    RECALL_EXCLUSION_REASONS.length,
    '登记表与枚举必须一一对应：多一个键说明枚举被删过而登记留下了'
  )
})

test('可触发的理由必须写清生产者；保留位必须写清解锁条件', () => {
  for (const reason of RECALL_EXCLUSION_REASONS) {
    const fact = RECALL_EXCLUSION_REASON_FACTS[reason]
    expect.ok(['eligibility', 'ranking', 'budget'].includes(fact.stage), `${reason} 的阶段必须已登记`)
    expect.ok(fact.semantics.trim().length > 0, `${reason} 必须有语义说明`)
    if (fact.reachable) {
      expect.ok(
        fact.producer.trim().length > 0 && fact.producer !== '（尚无生产者）',
        `${reason} 标成可触发，就必须写出生产者`
      )
    } else {
      expect.ok(
        (fact.blocker ?? '').trim().length > 0,
        `${reason} 标成保留位，就必须写清"为什么今天触发不了、什么条件才解锁"`
      )
    }
  }
})

test('保留位恰好是 DELETED 与 NOT_ACTIVE（其余都必须真的会被触发）', () => {
  expect.deepEqual(
    [...RESERVED_EXCLUSION_REASONS].sort(),
    ['DELETED', 'NOT_ACTIVE'],
    '保留位集合是这份契约的"诚实清单"，改动必须是有意的'
  )
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.DELETED.reachable, false)
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.NOT_ACTIVE.reachable, false)
})

test('用保留位当真实理由 → 运行期拒绝（不是靠 review 记得）', async () => {
  await expect.rejects(async () => assertExclusionReasonReachable('DELETED'), 'exclusion_reason_not_reachable')
  await expect.rejects(async () => assertExclusionReasonReachable('NOT_ACTIVE'), 'exclusion_reason_not_reachable')
  // 可触发的理由不该被拦
  assertExclusionReasonReachable('FORGOTTEN')
  assertExclusionReasonReachable('ORPHANED_EVIDENCE')
})

test('三个阶段的划分与"修法不同"一致', () => {
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.WRONG_USER.stage, 'eligibility')
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.ORPHANED_EVIDENCE.stage, 'eligibility')
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.LOW_RELEVANCE.stage, 'ranking')
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.DUPLICATE.stage, 'ranking')
  expect.equal(RECALL_EXCLUSION_REASON_FACTS.BUDGET_EXHAUSTED.stage, 'budget')
})

// ===========================================================================
group('与 M4 的唯一接缝（不重复定义资格）')
// ===========================================================================

test('exclusionReasonForStatus 与 isRecallEligible 逐状态一致', () => {
  for (const status of MEMORY_STATUSES) {
    const reason = exclusionReasonForStatus(status)
    expect.equal(
      reason === undefined,
      isRecallEligible(status),
      `${status}：可召回的判据必须与 M4 的 isRecallEligible 完全一致（两处定义漂移不会报错）`
    )
  }
})

test('两个不可召回状态各自映射到它自己的理由', () => {
  expect.equal(exclusionReasonForStatus('retracted'), 'FORGOTTEN')
  expect.equal(exclusionReasonForStatus('superseded'), 'SUPERSEDED')
  expect.equal(exclusionReasonForStatus('active'), undefined)
  expect.equal(exclusionReasonForStatus('disputed'), undefined)
})

test('四个状态全部被覆盖（穷尽 switch 的证据）', () => {
  const covered = MEMORY_STATUSES.filter((s: MemoryStatus) => exclusionReasonForStatus(s) !== undefined)
  expect.equal(covered.length, 2, '今天只有两个状态不可召回 —— 增减必须是有意的')
})

// ===========================================================================
group('RecallRequest：构造与边界（validate）')
// ===========================================================================

test('缺省值稳定且可预测', () => {
  const req = request()
  expect.equal(req.intent, 'unspecified')
  expect.deepEqual(req.target, { status: 'none' })
  expect.deepEqual(req.timeScope, { kind: 'any' })
  expect.equal(req.candidateLimit, RECALL_LIMITS.defaultCandidateLimit)
  expect.equal(req.contextBudget.memoryTokens, RECALL_LIMITS.defaultMemoryTokens)
  expect.equal(req.query.source, 'user_message')
  expect.equal(req.memoryKinds, undefined)
})

test('traceId / query / user 的失败关闭', async () => {
  await expect.rejects(
    async () => createRecallRequest({ ...request(), traceId: '   ' }),
    'recall_without_trace'
  )
  await expect.rejects(
    async () =>
      createRecallRequest({
        traceId: 'trace:wp1',
        characterId: 'c',
        user: entityRef('user', 'u'),
        query: { text: '   ' },
      }),
    'recall_without_query'
  )
  await expect.rejects(
    async () =>
      createRecallRequest({
        traceId: 'trace:wp1',
        characterId: 'c',
        // 把角色当成"请求归属的用户" —— 那会让 subject 作用域失去意义
        user: entityRef('character', 'char_sumuwei'),
        query: { text: '你好' },
      }),
    'recall_user_not_user'
  )
})

test('候选数与预算都有硬边界（没有上界的召回等于没有召回）', async () => {
  await expect.rejects(async () => request({ candidateLimit: 0 }), 'recall_bad_number')
  await expect.rejects(async () => request({ candidateLimit: 201 }), 'recall_bad_number')
  await expect.rejects(async () => request({ candidateLimit: 1.5 }), 'recall_bad_number')
  await expect.rejects(
    async () => request({ contextBudget: { memoryTokens: 0 } }),
    'recall_bad_number'
  )
  await expect.rejects(
    async () => request({ contextBudget: { memoryTokens: 100000 } }),
    'recall_bad_number'
  )
  await expect.rejects(
    async () => request({ contextBudget: { memoryTokens: 100, reservedTokens: -1 } }),
    'recall_bad_number'
  )
})

test('memoryKinds 空数组不是"全部"（它是错误）', async () => {
  await expect.rejects(async () => request({ memoryKinds: [] }), 'recall_empty_memory_kinds')
  await expect.rejects(
    async () => request({ memoryKinds: ['nope'] as never }),
    'recall_unknown_memory_kind'
  )
  const req = request({ memoryKinds: ['preference'] })
  expect.deepEqual(req.memoryKinds, ['preference'])
})

test('timeScope 的区间必须自洽', async () => {
  await expect.rejects(
    async () => request({ timeScope: { kind: 'range', from: 200, to: 100 } }),
    'recall_bad_time_scope'
  )
  await expect.rejects(
    async () => request({ timeScope: { kind: 'never' as never } }),
    'recall_bad_time_scope'
  )
  const req = request({ timeScope: { kind: 'range', from: 100, to: 200 } })
  expect.equal(req.timeScope.kind, 'range')
})

test('intent 与 channel 的登记表', () => {
  expect.deepEqual([...RECALL_INTENTS].sort(), [
    'current_fact',
    'experience',
    'historical',
    'identity',
    'unspecified',
  ])
  expect.equal(isRecallIntent('historical'), true)
  expect.equal(isRecallIntent('nope'), false)
  expect.equal(isRecallChannel('lexical'), true)
  expect.equal(isRecallChannel('mind-reading'), false)
  expect.ok(RECALL_CHANNELS.includes('subject'))
})

// ===========================================================================
group('序列化 / 反序列化（AT1.2）')
// ===========================================================================

test('serialize → parse 往返得到同一个请求', () => {
  const req = request({ intent: 'identity', candidateLimit: 7, memoryKinds: ['person_fact'] })
  const restored = parseRecallRequest(JSON.parse(serializeRecallRequest(req)))
  expect.deepEqual(restored, req)
})

test('序列化是稳定的：同一个请求两次得到同一串，键序不影响结果', () => {
  const a = request()
  const b = request()
  expect.equal(serializeRecallRequest(a), serializeRecallRequest(b))
  expect.equal(recallRequestDigest(a), recallRequestDigest(b))

  // 手工把键序打乱，再 parse：得到的请求必须与原请求等价
  const shuffled = JSON.parse(serializeRecallRequest(a)) as Record<string, unknown>
  const reordered: Record<string, unknown> = {}
  for (const key of Object.keys(shuffled).reverse()) reordered[key] = shuffled[key]
  expect.deepEqual(parseRecallRequest(reordered), a)
})

test('parse 的失败关闭：错误码是可断言的', async () => {
  await expect.rejects(async () => parseRecallRequest('nope'), 'recall_request_not_object')
  await expect.rejects(
    async () => parseRecallRequest({ traceId: 't', characterId: 'c' }),
    'recall_request_missing_query'
  )
  await expect.rejects(
    async () =>
      parseRecallRequest({
        traceId: 't',
        characterId: 'c',
        query: { text: 'hi', source: 'telepathy' },
      }),
    'recall_request_bad_query_source'
  )
  await expect.rejects(
    async () =>
      parseRecallRequest({
        traceId: 't',
        characterId: 'c',
        query: { text: 'hi', source: 'user_message' },
      }),
    'recall_request_missing_user'
  )
  await expect.rejects(
    async () =>
      parseRecallRequest({
        traceId: 't',
        characterId: 'c',
        query: { text: 'hi', source: 'user_message' },
        user: { kind: 'user', id: 'u' },
      }),
    'recall_request_missing_budget'
  )
  await expect.rejects(
    async () =>
      parseRecallRequest({
        traceId: 't',
        characterId: 'c',
        query: { text: 'hi', source: 'user_message' },
        user: { kind: 'user', id: 'u' },
        contextBudget: { memoryTokens: 100 },
        intent: 'guessing',
      }),
    'recall_unknown_intent'
  )
})

test('target 的三态在 parse 时被校验（ambiguous 至少两条）', async () => {
  const base = {
    traceId: 't',
    characterId: 'c',
    query: { text: 'hi', source: 'user_message' },
    user: { kind: 'user', id: 'u' },
    contextBudget: { memoryTokens: 100 },
  }
  await expect.rejects(
    async () => parseRecallRequest({ ...base, target: { status: 'maybe' } }),
    'recall_bad_target'
  )
  await expect.rejects(
    async () => parseRecallRequest({ ...base, target: { status: 'ambiguous', candidates: 1, via: 'x' } }),
    'recall_bad_target'
  )
  await expect.rejects(
    async () => parseRecallRequest({ ...base, target: { status: 'resolved', via: 'x' } }),
    'recall_bad_target'
  )
  const ok = parseRecallRequest({
    ...base,
    target: { status: 'resolved', subject: { kind: 'user', id: 'u' }, via: 'canonical_key', confidence: 'exact' },
  })
  expect.equal(ok.target.status, 'resolved')
})

// ===========================================================================
group('RecallDecision 的自洽性（trace 可解释性）')
// ===========================================================================

test('选中的决策不许带理由，也不许来自未通过资格', async () => {
  await expect.rejects(
    async () =>
      assertRecallDecision({ memoryId: 'm1' as never, eligible: true, reason: 'POLICY', selected: true }),
    'recall_decision_inconsistent'
  )
  await expect.rejects(
    async () => assertRecallDecision({ memoryId: 'm1' as never, eligible: false, selected: true }),
    'recall_decision_inconsistent'
  )
  assertRecallDecision({ memoryId: 'm1' as never, eligible: true, selected: true })
})

test('没选中的决策必须有理由（否则 trace 无法回答"为什么没想起来"）', async () => {
  await expect.rejects(
    async () => assertRecallDecision({ memoryId: 'm1' as never, eligible: true, selected: false }),
    'recall_decision_missing_reason'
  )
})

test('理由的阶段必须与 eligible 一致（资格拒绝 ≠ 排序淘汰）', async () => {
  await expect.rejects(
    async () =>
      assertRecallDecision({ memoryId: 'm1' as never, eligible: true, reason: 'WRONG_USER', selected: false }),
    'recall_decision_stage_mismatch'
  )
  await expect.rejects(
    async () =>
      assertRecallDecision({
        memoryId: 'm1' as never,
        eligible: false,
        reason: 'BUDGET_EXHAUSTED',
        selected: false,
      }),
    'recall_decision_stage_mismatch'
  )
  // 合法的两种：资格拒绝（eligible=false）与排序/预算淘汰（eligible=true）
  assertRecallDecision({ memoryId: 'm1' as never, eligible: false, reason: 'FORGOTTEN', selected: false })
  assertRecallDecision({ memoryId: 'm1' as never, eligible: true, reason: 'LOW_RELEVANCE', selected: false })
  assertRecallDecision({
    memoryId: 'm1' as never,
    eligible: true,
    reason: 'BUDGET_EXHAUSTED',
    selected: false,
  })
})

test('保留位出现在决策里 → 被拒（DELETED 不可以当"证据缺失"用）', async () => {
  await expect.rejects(
    async () =>
      assertRecallDecision({ memoryId: 'm1' as never, eligible: false, reason: 'DELETED', selected: false }),
    'exclusion_reason_not_reachable'
  )
  // 正确的那个是 ORPHANED_EVIDENCE
  assertRecallDecision({
    memoryId: 'm1' as never,
    eligible: false,
    reason: 'ORPHANED_EVIDENCE',
    selected: false,
  })
})

// ===========================================================================
group('ContextBundle 与"判不出来就不选"（G2 的契约落点）')
// ===========================================================================

test('空 bundle 是一等公民：有理由、有账、externalEvidence 恒定为空', () => {
  const req = request({ target: { status: 'ambiguous', candidates: 2, via: 'hint_scoring' } })
  const bundle = createEmptyContextBundle({
    request: req,
    decisions: [{ memoryId: 'm1' as never, eligible: false, reason: 'INVALID_TARGET', selected: false }],
    now: NOW,
  })
  expect.deepEqual(bundle.selected, [])
  expect.equal(bundle.budget.memoryTokens, 0)
  expect.equal(bundle.budget.budgetTokens, req.contextBudget.memoryTokens)
  expect.deepEqual(bundle.externalEvidence, [])
  expect.equal(bundle.decisions.length, 1)
})

test('空 bundle 不许夹带被选中的决策', async () => {
  await expect.rejects(
    async () =>
      createEmptyContextBundle({
        request: request(),
        decisions: [{ memoryId: 'm1' as never, eligible: true, selected: true }],
        now: NOW,
      }),
    'recall_empty_bundle_with_selection'
  )
})

test('bundle 的三条不变量', async () => {
  // ① selected=true 的决策必须真的在 selected 里
  await expect.rejects(
    async () =>
      assertContextBundle(
        bundleOf({
          decisions: [{ memoryId: 'm1' as never, eligible: true, selected: true }],
          selected: [],
        })
      ),
    'recall_bundle_selection_mismatch'
  )

  /*
   * ② M5.5 / COMPAT-1：外部证据的判据从 M5 的"非空即拒"**取代**为
   *    "非空必须通过 M5.5 的验证器"（ADR-045 附录 B）。
   *
   *    旧锁是 M5 的（那时确实不实现外部证据），M5 的历史 PASS 一字未改；
   *    这一条登记的是**判据取代**，不是把过去的结论改写。
   *
   *    方向没变：绕过 M5.5 入口自造的引用仍然进不去 ——
   *      · 合法证据 ⇒ 接受（M5.5 的入口能用，是前提）
   *      · 非法证据 ⇒ 拒（非 HTTPS / 缺指纹 / 标签顺序不对 / 重复来源）
   */
  const legalEvidenceRef = {
    kind: 'external_evidence' as const,
    id: 'searxng-local:e1:fp-1',
    provider: 'searxng-local',
    source: 'https://example.com/a',
    retrievedAt: NOW,
    contentFingerprint: 'fp-1',
    citationLabel: 'E1',
  }
  assertContextBundle({ ...bundleOf({}), externalEvidence: [legalEvidenceRef] })

  // 非 HTTPS 的来源：M5.5 只接受 HTTPS（`isHttpsUri` 用 URL 解析，不看前缀）
  await expect.rejects(
    async () =>
      assertContextBundle({
        ...bundleOf({}),
        externalEvidence: [{ ...legalEvidenceRef, source: 'http://example.com/a' }],
      }),
    'external_evidence_refs_invalid'
  )

  // 两条引用却都叫 E1，且来源重复：标签顺序与唯一性都必须成立
  await expect.rejects(
    async () =>
      assertContextBundle({
        ...bundleOf({}),
        externalEvidence: [
          { ...legalEvidenceRef },
          { ...legalEvidenceRef, id: 'searxng-local:e2:fp-2', contentFingerprint: 'fp-2' },
        ],
      }),
    'external_evidence_refs_invalid'
  )

  // ③ 选中的记忆合计不能超过预算（预算给到装不下为止）
  await expect.rejects(
    async () =>
      assertContextBundle(
        bundleOf({ request: request({ contextBudget: { memoryTokens: 5 } }), selected: [selectedMemory()] })
      ),
    'recall_budget_exceeded'
  )

  // 合法的那个
  const good = bundleOf({
    decisions: [{ memoryId: candidate().memoryId, eligible: true, selected: true }],
    selected: [selectedMemory()],
  })
  assertContextBundle(good)
})

// ===========================================================================
group('隐私：进 trace 的形态里没有正文')
// ===========================================================================

test('serializeContextBundleForTrace 不含 dataText（一个字都不含）', () => {
  const req = request()
  const bundle = bundleOf({
    request: req,
    candidates: [candidate()],
    decisions: [
      { memoryId: candidate().memoryId, eligible: true, selected: true },
      { memoryId: 'mem:other' as never, eligible: true, reason: 'LOW_RELEVANCE', selected: false },
      { memoryId: 'mem:third' as never, eligible: true, reason: 'BUDGET_EXHAUSTED', selected: false },
    ],
    selected: [selectedMemory()],
  })

  const view = serializeContextBundleForTrace(bundle)
  const json = JSON.stringify(view)

  expect.notIncludes(json, '示例工程科技大学', '正文/可搜索文本不许进 trace')
  expect.notIncludes(json, 'dataText')
  expect.deepEqual(view.selectedIds, [String(candidate().memoryId)])
  expect.deepEqual(view.selectedFingerprints, ['fp-abc'])
  expect.equal(view.candidateCount, 1)
  expect.equal(view.externalEvidenceCount, 0)
  expect.equal(view.exclusionHistogram['LOW_RELEVANCE'], 1)
  expect.equal(view.exclusionHistogram['BUDGET_EXHAUSTED'], 1)
  expect.ok(typeof view.requestDigest === 'string' && view.requestDigest.length > 0)
})

test('describeRecallCandidate 也不含正文', () => {
  const line = describeRecallCandidate(candidate())
  expect.notIncludes(line, '示例工程科技大学')
  expect.includes(line, 'person_fact/active')
  expect.includes(line, 'subject+lexical')
})

test('describeExclusionReason 必须指出生产者（不是一句空话）', () => {
  const text = describeExclusionReason('ORPHANED_EVIDENCE')
  expect.includes(text, 'ORPHANED_EVIDENCE')
  expect.includes(text, 'WP2')
})

// ===========================================================================
// 证据（给 M5 的验收报告用）
// ===========================================================================

const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M5 WP1 Recall 契约测试')

mkdirSync(join(process.cwd(), 'artifacts', 'm5'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5', 'wp1-contracts.json'),
  `${JSON.stringify(
    {
      testId: 'M5 / WP1 recall contracts',
      generatedAt: new Date().toISOString(),
      passed: summary.passed,
      failed: summary.failed,
      failures: summary.failures.map((item) => item.name),
      exclusionReasons: RECALL_EXCLUSION_REASONS.map((reason) => ({
        reason,
        ...RECALL_EXCLUSION_REASON_FACTS[reason],
      })),
      reserved: RESERVED_EXCLUSION_REASONS,
      limits: RECALL_LIMITS,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5/wp1-contracts.json')

process.exit(summary.failed === 0 ? 0 : 1)
