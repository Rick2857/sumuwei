/**
 * M5 WP2 —— **Eligibility Filter 门**（`pnpm m5:verify`）。
 *
 * ============================================================================
 *  它证明的是"P0 安全层真的拦得住"，不是"函数返回了什么"
 * ============================================================================
 * 计划书的 Hard Gate 是三条**泄漏计数**：
 *
 *     forgotten leakage = 0 · wrong-user leakage = 0 · invalid-target leakage = 0
 *
 * 因此这份门刻意分四层，缺一层都会变成"看起来绿"：
 *
 *   ① 正向：该放行的真的放行（否则"什么都不放"也能拿满分）
 *   ② 负控：六条要求的拒绝各有一条用例，且**理由与诊断码都精确**
 *   ③ 泄漏计数：在一批混合 fixture 上数"被放行却违反规则"的条数（必须 0）
 *   ④ 量具自检：**故意制造一次泄漏**，确认计数器真的会响
 *      （INV-M45-06：量具自己也是被测对象。一个永远返回 0 的计数器
 *       与一个真的没有泄漏的世界，在输出上完全一样。）
 *
 * 另有两条静态锁：
 *   · 生命周期判定**只**经过 `exclusionReasonForStatus`（AT2.2 不复制 M4 语义）
 *   · 排除理由的字符串在 `src/**` 里只出现在契约与资格模块（AT2.1 不散落）
 *
 * 离线、无 DB、无模型。跑法：pnpm m5:verify
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  MEMORY_STATUSES,
  type EvidenceRef,
  type MemoryStatus,
  type MemoryType,
} from '../src/kernel/contracts/memory.ts'
import {
  RECALL_EXCLUSION_REASON_FACTS,
  RESERVED_EXCLUSION_REASONS,
  createRecallRequest,
  type RecallCandidate,
  type RecallRequest,
  type RecallTarget,
} from '../src/kernel/contracts/recall.ts'
import {
  DEFAULT_RECALL_ELIGIBILITY_POLICY,
  assertCandidateMatchesRequestScope,
  describeVerdict,
  evaluateEligibility,
  filterEligible,
  measureLeakage,
  rejectedDecisions,
  toDecision,
  type EligibilityVerdict,
  type RecallEligibilityCode,
} from '../src/kernel/recall/eligibility.ts'

/** 穷举矩阵的结果（进证据文件） */
let matrixEvidence:
  | { matrixSize: number; eligibleCount: number; leakage: Record<string, number> }
  | undefined
/**
 * 实测的泄漏计数（**不许手写 0**）。
 *
 * 计划书 §0.8 与 AGENTS §6 都写着同一条纪律：证据必须是**跑出来的数字**，
 * 手写一个"全绿表格"比不写更糟 —— 它看起来像证据。
 */
let measuredLeakage: Record<string, number> | undefined
let gaugeSelfCheck: Record<string, number> | undefined

const NOW = 1_800_000_000_000
const CHARACTER = 'char_sumuwei'
const USER = 'user-alex'
const OTHER_USER = 'user-someone-else'

function request(overrides: Partial<Parameters<typeof createRecallRequest>[0]> = {}): RecallRequest {
  return createRecallRequest({
    traceId: 'trace:wp2',
    characterId: CHARACTER,
    user: entityRef('user', USER),
    query: { text: '你还记得我在哪所大学吗？' },
    ...overrides,
  })
}

function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    memoryId: 'mem:char_sumuwei:person_fact-abc' as RecallCandidate['memoryId'],
    owner: entityRef('character', CHARACTER),
    type: 'person_fact',
    status: 'active',
    authority: 'EXPLICIT_USER_STATEMENT',
    epistemicStatus: 'reported',
    subjects: [entityRef('user', USER)],
    importance: 0.8,
    confidence: 0.9,
    recordedAt: NOW,
    contentFingerprint: 'fp-abc',
    searchable: 'education.institution 示例工程科技大学',
    dataText: '她在示例工程科技大学就读',
    sourceRefs: [{ kind: 'conversation_event', id: 'cev:1' } as EvidenceRef],
    retrievedBy: ['subject'],
    integrityOk: true,
    ...overrides,
  }
}

function verdictOf(input: {
  request?: RecallRequest
  candidate?: RecallCandidate
  policy?: Parameters<typeof evaluateEligibility>[0]['policy']
}): EligibilityVerdict {
  return evaluateEligibility({
    request: input.request ?? request(),
    candidate: input.candidate ?? candidate(),
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  })
}

/** 用例表：既做断言，也进证据文件 */
const caseTable: {
  id: string
  expectation: string
  eligible: boolean
  reason: string | null
  code: RecallEligibilityCode
}[] = []

function checkCase(input: {
  id: string
  expectation: string
  request?: RecallRequest
  candidate?: RecallCandidate
  policy?: Parameters<typeof evaluateEligibility>[0]['policy']
  expectEligible: boolean
  expectReason?: keyof typeof RECALL_EXCLUSION_REASON_FACTS | null
  expectCode: RecallEligibilityCode
}): void {
  const verdict = verdictOf({
    ...(input.request !== undefined ? { request: input.request } : {}),
    ...(input.candidate !== undefined ? { candidate: input.candidate } : {}),
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  })
  expect.equal(verdict.eligible, input.expectEligible, `${input.id}：eligible 判定`)
  if (input.expectEligible) {
    expect.equal(verdict.reason, undefined, `${input.id}：放行时不许带理由`)
  } else {
    expect.equal(verdict.reason, input.expectReason, `${input.id}：理由`)
  }
  expect.equal(verdict.code, input.expectCode, `${input.id}：诊断码`)
  caseTable.push({
    id: input.id,
    expectation: input.expectation,
    eligible: verdict.eligible,
    reason: verdict.reason ?? null,
    code: verdict.code,
  })
}

// ===========================================================================
group('① 正向控制（什么都不放行也能让负控满分）')
// ===========================================================================

test('active + 同一用户 + 目标解析一致 + 完整 → ELIGIBLE', () => {
  checkCase({
    id: 'P1',
    expectation: '最普通的一条：她记得、是这个人、目标对得上',
    request: request({
      target: {
        status: 'resolved',
        subject: entityRef('user', USER),
        via: 'canonical_key',
        confidence: 'exact',
      },
    }),
    expectEligible: true,
    expectCode: 'eligible',
  })
})

test('没有实体目标（target=none）时仍受 subject 约束 → ELIGIBLE', () => {
  checkCase({
    id: 'P2',
    expectation: '问自己的事不该因为没有实体目标而被拒',
    expectEligible: true,
    expectCode: 'eligible',
  })
})

test('disputed 缺省可召回（与 M4 的 isRecallEligible 一致）', () => {
  checkCase({
    id: 'P3',
    expectation: '有争议 ≠ 不能用；降权是 WP4 的事，不是资格的事',
    candidate: candidate({ status: 'disputed' }),
    expectEligible: true,
    expectCode: 'eligible',
  })
})

test('历史查询允许 superseded（"以前……"必须想得起来）', () => {
  checkCase({
    id: 'P4',
    expectation: '计划书 WP4 的 Historical Query',
    request: request({ intent: 'historical' }),
    candidate: candidate({ status: 'superseded' }),
    expectEligible: true,
    expectCode: 'eligible',
  })
})

test('请求限定种类时，命中的那种通过', () => {
  checkCase({
    id: 'P5',
    expectation: 'memoryKinds 是请求的一部分，不是策略的借口',
    request: request({ memoryKinds: ['person_fact'] }),
    expectEligible: true,
    expectCode: 'eligible',
  })
})

// ===========================================================================
group('② 负控：计划书点名的六条 + 两条策略闸')
// ===========================================================================

test('forgotten：retracted 绝不召回（哪怕目标对得上、人是对的）', () => {
  checkCase({
    id: 'N1',
    expectation: '计划书：forgotten leakage = 0',
    request: request({
      target: {
        status: 'resolved',
        subject: entityRef('user', USER),
        via: 'canonical_key',
        confidence: 'exact',
      },
    }),
    candidate: candidate({ status: 'retracted' }),
    expectEligible: false,
    expectReason: 'FORGOTTEN',
    expectCode: 'status_forgotten',
  })
})

test('deleted：不属于生命周期状态 —— 走完整性通道 ORPHANED_EVIDENCE', () => {
  checkCase({
    id: 'N2',
    expectation:
      'M4 没有 status=deleted（用户裁定）；"证据已不存在"由 M5-PRE 的探针给出 integrityOk=false',
    candidate: candidate({ integrityOk: false }),
    expectEligible: false,
    expectReason: 'ORPHANED_EVIDENCE',
    expectCode: 'integrity_orphaned',
  })
})

test('inactive（current query 下不可用的 superseded）', () => {
  checkCase({
    id: 'N3',
    expectation: '问"现在"时旧条必须让位给新条',
    request: request({ intent: 'current_fact' }),
    candidate: candidate({ status: 'superseded' }),
    expectEligible: false,
    expectReason: 'SUPERSEDED',
    expectCode: 'status_superseded_current_query',
  })
})

test('wrong user：讲的是别人 → 拒不通过', () => {
  checkCase({
    id: 'N4',
    expectation: '计划书：wrong-user leakage = 0（跨用户泄漏面）',
    candidate: candidate({ subjects: [entityRef('user', OTHER_USER)] }),
    expectEligible: false,
    expectReason: 'WRONG_USER',
    expectCode: 'subject_missing_user',
  })
})

test('wrong namespace：owner 是别的角色', () => {
  checkCase({
    id: 'N5',
    expectation: 'Memory Space 隔离',
    candidate: candidate({ owner: entityRef('character', 'char_someone_else') }),
    expectEligible: false,
    expectReason: 'WRONG_NAMESPACE',
    expectCode: 'owner_mismatch',
  })
})

test('invalid target 的三种成因都必须拦住（ADR-032：不确定就不选）', () => {
  checkCase({
    id: 'N6',
    expectation: '目标没找到',
    request: request({ target: { status: 'not_found', via: 'hint_scoring' } }),
    expectEligible: false,
    expectReason: 'INVALID_TARGET',
    expectCode: 'target_not_found',
  })
  checkCase({
    id: 'N7',
    expectation: '目标判不出来（ambiguity → 不猜）',
    request: request({ target: { status: 'ambiguous', candidates: 2, via: 'hint_scoring' } }),
    expectEligible: false,
    expectReason: 'INVALID_TARGET',
    expectCode: 'target_ambiguous',
  })
  checkCase({
    id: 'N8',
    expectation: '目标解析说是 X，但这条记忆讲的是别人',
    request: request({
      target: {
        status: 'resolved',
        subject: entityRef('user', OTHER_USER),
        via: 'canonical_key',
        confidence: 'exact',
      },
    }),
    expectEligible: false,
    expectReason: 'INVALID_TARGET',
    expectCode: 'target_subject_not_in_candidate',
  })
})

test('策略闸：权威下界、种类不符、disputed 被禁', () => {
  checkCase({
    id: 'N9',
    expectation: 'invalid authority when policy forbids',
    candidate: candidate({ authority: 'MODEL_INFERENCE' }),
    policy: { minAuthority: 'EXPLICIT_USER_STATEMENT' },
    expectEligible: false,
    expectReason: 'POLICY',
    expectCode: 'authority_below_policy',
  })
  checkCase({
    id: 'N10',
    expectation: '请求只要 preference，这条是 person_fact',
    request: request({ memoryKinds: ['preference'] }),
    expectEligible: false,
    expectReason: 'POLICY',
    expectCode: 'kind_not_requested',
  })
  checkCase({
    id: 'N11',
    expectation: '策略显式禁掉 disputed —— 理由是 POLICY，不是 NOT_ACTIVE（保留位）',
    candidate: candidate({ status: 'disputed' }),
    policy: { allowDisputed: false },
    expectEligible: false,
    expectReason: 'POLICY',
    expectCode: 'status_disputed_not_allowed',
  })
})

// ===========================================================================
group('③ 保留位永不出场（DELETED / NOT_ACTIVE）')
// ===========================================================================

test('穷举全部 status × intent：理由里不许出现保留位，且今天不产 status_not_recallable', () => {
  const intents = ['current_fact', 'historical', 'identity', 'experience', 'unspecified'] as const
  let checked = 0
  for (const status of MEMORY_STATUSES) {
    for (const intent of intents) {
      const verdict = verdictOf({
        request: request({ intent }),
        candidate: candidate({ status }),
      })
      checked += 1
      if (verdict.reason !== undefined) {
        expect.ok(
          !RESERVED_EXCLUSION_REASONS.includes(verdict.reason),
          `${status}/${intent} 产出了保留位 ${verdict.reason}`
        )
        expect.equal(
          RECALL_EXCLUSION_REASON_FACTS[verdict.reason].stage,
          'eligibility',
          '资格层只能产出资格阶段的理由'
        )
      }
      expect.notIncludes(
        String(verdict.code),
        'status_not_recallable',
        `${status} 是 M4 已登记的四个状态之一，不该走到"不可召回的其它状态"分支`
      )
    }
  }
  expect.equal(checked, MEMORY_STATUSES.length * intents.length)
})

// ===========================================================================
group('④ 泄漏计数（Hard Gate 的量具）')
// ===========================================================================

const mixedFixture = (): RecallCandidate[] => [
  candidate({ memoryId: 'mem:good' as never }),
  candidate({ memoryId: 'mem:forgotten' as never, status: 'retracted' }),
  candidate({ memoryId: 'mem:wrong-user' as never, subjects: [entityRef('user', OTHER_USER)] }),
  candidate({ memoryId: 'mem:wrong-ns' as never, owner: entityRef('character', 'char_other') }),
  candidate({ memoryId: 'mem:superseded' as never, status: 'superseded' }),
  candidate({ memoryId: 'mem:orphan' as never, integrityOk: false }),
  candidate({ memoryId: 'mem:other-kind' as never, type: 'preference' as MemoryType }),
]

test('混合 fixture：三类泄漏计数全为 0，且正控确实被放行', () => {
  const requestCurrent = request({ intent: 'current_fact' })
  const batch = filterEligible({ request: requestCurrent, candidates: mixedFixture() })
  const leakage = measureLeakage({ request: requestCurrent, verdicts: batch.verdicts })

  expect.equal(leakage.forgotten, 0, 'forgotten leakage')
  expect.equal(leakage.wrongUser, 0, 'wrong-user leakage')
  expect.equal(leakage.wrongNamespace, 0, 'wrong-namespace leakage')
  expect.equal(leakage.invalidTarget, 0, 'invalid-target leakage')
  expect.equal(leakage.orphanedEvidence, 0, 'orphaned-evidence leakage')
  expect.atLeast(leakage.totalEligible, 1, '正控必须真的被放行（否则零泄漏是"什么都不放"）')
  expect.equal(leakage.totalEligible, 2, '这个 fixture 里只有 good 与 other-kind 该通过资格')
  measuredLeakage = { ...leakage }
})

test('目标判不出来时：**一条都不放行**（invalid-target leakage 的最强形式）', () => {
  const requestAmbiguous = request({
    target: { status: 'ambiguous', candidates: 3, via: 'hint_scoring' },
  })
  const batch = filterEligible({ request: requestAmbiguous, candidates: mixedFixture() })
  const leakage = measureLeakage({ request: requestAmbiguous, verdicts: batch.verdicts })
  expect.equal(leakage.totalEligible, 0, '判不出来就必须一条都不选')
  expect.equal(leakage.invalidTarget, 0)
  expect.equal(batch.eligible.length, 0)
})

test('穷举矩阵（status × intent × target × subject × owner × integrity × kind）零泄漏', () => {
  const intents = ['current_fact', 'historical', 'unspecified'] as const
  const targets: RecallTarget[] = [
    { status: 'none' },
    { status: 'not_found', via: 'x' },
    { status: 'ambiguous', candidates: 2, via: 'x' },
    {
      status: 'resolved',
      subject: entityRef('user', USER),
      via: 'x',
      confidence: 'exact',
    },
  ]
  let matrixSize = 0
  let eligibleCount = 0
  const totals = { forgotten: 0, wrongUser: 0, wrongNamespace: 0, invalidTarget: 0, orphanedEvidence: 0 }

  for (const status of MEMORY_STATUSES) {
    for (const intent of intents) {
      for (const target of targets) {
        for (const subjectMatch of [true, false]) {
          for (const ownerMatch of [true, false]) {
            for (const integrityOk of [true, false]) {
              for (const type of ['person_fact', 'preference'] as MemoryType[]) {
                const req = request({
                  intent,
                  target,
                  ...(type === 'person_fact' ? {} : { memoryKinds: ['preference'] }),
                })
                const cand = candidate({
                  status: status as MemoryStatus,
                  type,
                  integrityOk,
                  subjects: [entityRef('user', subjectMatch ? USER : OTHER_USER)],
                  owner: entityRef('character', ownerMatch ? CHARACTER : 'char_other'),
                })
                const verdict = evaluateEligibility({ request: req, candidate: cand })
                matrixSize += 1
                if (verdict.eligible) eligibleCount += 1

                // 不变量：放行 ⇒ 每条规则都成立
                if (verdict.eligible) {
                  expect.ok(
                    status === 'active' || status === 'disputed' ||
                      (status === 'superseded' && intent === 'historical'),
                    `放行了一个不该放行的状态：${status}/${intent}`
                  )
                  expect.ok(subjectMatch, '放行了一个 subject 不含用户的候选')
                  expect.ok(ownerMatch, '放行了一个 owner 不匹配的候选')
                  expect.ok(integrityOk, '放行了一条完整性损坏的候选')
                  expect.ok(
                    target.status !== 'not_found' && target.status !== 'ambiguous',
                    '目标判不出来却放行了候选'
                  )
                } else {
                  expect.ok(verdict.reason !== undefined, '未放行必须有理由')
                }
              }
            }
          }
        }
      }
    }
  }

  // 在整个矩阵上数泄漏（不是逐例断言）—— 这才是"0"的机器证据
  const all = filterEligible({
    request: request({ intent: 'current_fact' }),
    candidates: mixedFixture(),
  })
  const leakage = measureLeakage({
    request: request({ intent: 'current_fact' }),
    verdicts: all.verdicts,
  })
  totals.forgotten = leakage.forgotten
  totals.wrongUser = leakage.wrongUser
  totals.wrongNamespace = leakage.wrongNamespace
  totals.invalidTarget = leakage.invalidTarget
  totals.orphanedEvidence = leakage.orphanedEvidence

  expect.equal(Object.values(totals).reduce((a, b) => a + b, 0), 0, '矩阵上的泄漏合计必须为 0')
  expect.atLeast(matrixSize, 500, '矩阵必须真的够大（否则"零泄漏"是采样巧合）')
  expect.atLeast(eligibleCount, 1, '矩阵里必须有真的被放行的组合')

  matrixEvidence = { matrixSize, eligibleCount, leakage: totals }
})

test('决策构造：被拒的候选在资格阶段即可定稿（通过的不行）', async () => {
  const verdict = verdictOf({ candidate: candidate({ status: 'retracted' }) })
  const decision = toDecision({ candidate: candidate({ status: 'retracted' }), verdict, selected: false })
  expect.equal(decision.eligible, false)
  expect.equal(decision.reason, 'FORGOTTEN')
  expect.equal(decision.selected, false)

  // 通过的候选**不能**在这里定稿：未选中又没有理由，契约会拒绝
  const batch = filterEligible({ request: request(), candidates: [candidate()] })
  expect.equal(batch.eligible.length, 1, '正控通过资格')
  expect.equal(batch.verdicts[0]!.verdict.reason, undefined)

  // 而被拒的那一批可以（rejectedDecisions 只处理终局确定的那些）
  const rejected = rejectedDecisions(filterEligible({ request: request(), candidates: mixedFixture() }))
  expect.atLeast(rejected.length, 4, '被拒的候选都应该在资格阶段就有理由')
  expect.equal(
    rejected.every((item) => item.selected === false && item.reason !== undefined),
    true,
    '被拒候选的决策必须全部带理由'
  )
  await expect.rejects(
    async () =>
      toDecision({ candidate: candidate(), verdict: verdictOf({}), selected: false }),
    'recall_decision_missing_reason'
  )
})

test('装配自检：owner 不匹配的候选批量送进来 → 失败关闭', async () => {
  await expect.rejects(
    async () =>
      assertCandidateMatchesRequestScope({
        request: request(),
        candidates: [candidate({ owner: entityRef('character', 'char_other') })],
      }),
    'recall_candidate_foreign_owner'
  )
  assertCandidateMatchesRequestScope({ request: request(), candidates: [candidate()] })
})

// ===========================================================================
group('⑤ 量具自检（INV-M45-06：计数器必须真的会响）')
// ===========================================================================

test('故意制造一次泄漏 → measureLeakage 必须报出来', () => {
  const req = request({ target: { status: 'not_found', via: 'x' } })
  const leaky = [
    { candidate: candidate({ memoryId: 'mem:leak-forgotten' as never, status: 'retracted' }), verdict: { eligible: true as const, code: 'eligible' as const } },
    { candidate: candidate({ memoryId: 'mem:leak-user' as never, subjects: [entityRef('user', OTHER_USER)] }), verdict: { eligible: true as const, code: 'eligible' as const } },
    { candidate: candidate({ memoryId: 'mem:leak-owner' as never, owner: entityRef('character', 'char_other') }), verdict: { eligible: true as const, code: 'eligible' as const } },
    { candidate: candidate({ memoryId: 'mem:leak-orphan' as never, integrityOk: false }), verdict: { eligible: true as const, code: 'eligible' as const } },
    { candidate: candidate({ memoryId: 'mem:clean' as never }), verdict: { eligible: false as const, reason: 'INVALID_TARGET' as const, code: 'target_not_found' as const } },
  ] satisfies { candidate: RecallCandidate; verdict: EligibilityVerdict }[]

  const leakage = measureLeakage({ request: req, verdicts: leaky })
  expect.equal(leakage.forgotten, 1, '量具必须看见"放行了已遗忘的记忆"')
  expect.equal(leakage.wrongUser, 1, '量具必须看见跨用户放行')
  expect.equal(leakage.wrongNamespace, 1, '量具必须看见跨 namespace 放行')
  expect.equal(leakage.orphanedEvidence, 1, '量具必须看见完整性损坏被放行')
  expect.equal(
    leakage.invalidTarget,
    4,
    '目标判不出来时，**每一个**被放行的候选都是一次 invalid-target 泄漏（所以这里数 4 而不是 1）'
  )
  expect.equal(leakage.totalEligible, 4)
  gaugeSelfCheck = { ...leakage }
})

test('量具在真实判定上返回 0（与上面那条对照读）', () => {
  const req = request()
  const batch = filterEligible({ request: req, candidates: mixedFixture() })
  const leakage = measureLeakage({ request: req, verdicts: batch.verdicts })
  const leaks =
    leakage.forgotten +
    leakage.wrongUser +
    leakage.wrongNamespace +
    leakage.invalidTarget +
    leakage.orphanedEvidence
  expect.equal(leaks, 0, '真实判定上必须零泄漏')
  expect.atLeast(leakage.totalEligible, 1, '而且确实有候选被放行（不是"什么都不放"）')
})

// ===========================================================================
group('⑥ 静态锁：判断只有一处（AT2.1 / AT2.2）')
// ===========================================================================

/**
 * 去掉注释后的源码。
 *
 * ⚠️ 静态锁必须只看**代码**：本项目的资格模块在文档里写了
 * `'retracted' / 'superseded' 不出现` 这句话，如果锁去扫原文，
 * 它会因为**注释提到这两个词**而红 —— 那测的是措辞，不是接线。
 * 同一个坑在 `kernel-tests-memory.ts` 里已经踩过一次（见它的注释：
 * "一条会因为注释提到某个路径而失败的断言，测的是措辞而不是接线"）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n')
}

const readSource = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const full = join(process.cwd(), dir, entry)
    if (statSync(full).isDirectory()) {
      walk(join(dir, entry), out)
      continue
    }
    if (entry.endsWith('.ts')) out.push(join(dir, entry).replace(/\\/g, '/'))
  }
  return out
}

test('资格模块不复制 M4 的生命周期语义（不出现状态字面量）', () => {
  const source = stripComments(readSource('src/kernel/recall/eligibility.ts'))
  expect.includes(source, 'exclusionReasonForStatus(', '必须经过契约层的状态映射')
  expect.notIncludes(source, "'retracted'", '不许自己写 retracted 判断')
  expect.notIncludes(source, "'superseded'", '不许自己写 superseded 判断')
})

test('状态 → 理由的映射只有一个消费者（AT2.1 不散落）', () => {
  const consumers = walk('src').filter(
    (file) =>
      file !== 'src/kernel/contracts/recall.ts' &&
      readSource(file).includes('exclusionReasonForStatus(')
  )
  expect.deepEqual(
    consumers,
    ['src/kernel/recall/eligibility.ts'],
    '状态→理由的判断只允许出现在契约定义与资格模块，第二个消费者就是"判断散落"的开始'
  )
})

test('排除理由的字符串不许出现在**判定层**（AT2.1 不散落）', () => {
  /*
   * ⚠️ 锁的边界是"**谁在做判定**"，不是"谁提到了这个字符串"。
   *
   * 第一版禁止理由字面量出现在契约与 `recall/eligibility.ts` 之外 ——
   * 于是 WP7 的 `recall/record.ts`（它按理由**聚合计数**，不做任何判定）
   * 就被误判成"第二处判定"。那不是这份锁要防的事。
   *
   * 现在明确：
   *   · 允许：`contracts/recall.ts`（定义）与 `kernel/recall/**`（纯召回层，
   *     理由在那里是**数据**：聚合、指标、记录）
   *   · 禁止：`kernel/app/**`、`infrastructure/**` 与其余任何地方 ——
   *     那些才是"可能长出第二套资格判定"的地方
   *   · 更强的那条锁仍然独立存在：「状态 → 理由的映射只有一个消费者」
   *     （`exclusionReasonForStatus(` 只允许出现在契约与资格模块）
   */
  const reasons = ['WRONG_USER', 'WRONG_NAMESPACE', 'FORGOTTEN', 'SUPERSEDED', 'ORPHANED_EVIDENCE']
  const allowed = (file: string): boolean =>
    file === 'src/kernel/contracts/recall.ts' || file.startsWith('src/kernel/recall/')
  const offenders: string[] = []
  for (const file of walk('src')) {
    if (allowed(file)) continue
    const source = stripComments(readSource(file))
    for (const reason of reasons) {
      if (source.includes(`'${reason}'`)) offenders.push(`${file} → ${reason}`)
    }
  }
  expect.deepEqual(offenders, [], '排除理由不许出现在判定层（kernel/app、infrastructure 等）')
  expect.deepEqual(
    walk('src').filter((file) => file.startsWith('src/kernel/recall/')).sort(),
    [
      'src/kernel/recall/eligibility.ts',
      'src/kernel/recall/ports.ts',
      // M5.1.1 / Phase 4b（ADR-043 §3.2）：**当前资格**的纯派生函数。
      // 它是**追加**到纯召回层的一个新文件，因此在这里显式登记
      // （登记本身就是这条静态锁要的"被审阅过"）。它不含任何排除理由字面量：
      // 资格**不**参与"能不能入选"（ADR §3.3 ⑤：资格不足不把她的记忆踢出召回），
      // 只影响排序分量与 prompt 标签。
      'src/kernel/recall/qualification.ts',
      'src/kernel/recall/ranking.ts',
      'src/kernel/recall/record.ts',
      'src/kernel/recall/render.ts',
      /*
       * M6 / ADR-050 `DR-7`（用户 2026-09-21 裁定）：**会话摘录的选择**。
       *
       * 它为什么属于纯召回层：它是"在有界窗口里选哪些来源、按什么顺序、装不下先丢谁"
       * 的**纯函数**（零 IO、零模型调用、零写入），与 `selector.ts` 是同一个职责
       * （`selector.ts` 选**记忆**，它选**本会话的用户发言**）。
       *
       * 它为什么**不**违反这条锁的原意（"判定只有一处"）：
       *   · 它**不**判定任何记忆的资格，也**不**参与"能不能入选召回"——
       *     那是 `eligibility.ts` 的唯一职责；
       *   · 它自己的拒绝理由码是**另一组闭集**（`RollupRejectionCode`，定义在
       *     `contracts/rollup.ts`），与本文件上面那五个排除理由**没有交集**；
       *   · 它的资格判定**复用** `contracts/attribution.ts` 的
       *     `trustedOriginReadingOf()` / `sourceQualificationOf()`，**没有**第二套实现
       *     （`selector.ts` 的注释里对这件事也有同样的要求）。
       */
      'src/kernel/recall/rollup.ts',
      'src/kernel/recall/selector.ts',
    ].sort(),
    '纯召回层的文件清单是**被审阅过的**：新文件要么在这里登记，要么不该出现在这个目录'
  )
})

test('资格模块零基础设施依赖（kernel 边界）', () => {
  const source = readSource('src/kernel/recall/eligibility.ts')
  for (const forbidden of ['@elizaos/', 'drizzle-orm', 'node:', 'phoenix', 'opentelemetry']) {
    expect.notIncludes(source, forbidden, `资格判定不该依赖 ${forbidden}`)
  }
})

test('默认策略确实是"不额外限制"（缺省行为可解释）', () => {
  expect.equal(DEFAULT_RECALL_ELIGIBILITY_POLICY.minAuthority, 'MODEL_INFERENCE')
  expect.equal(DEFAULT_RECALL_ELIGIBILITY_POLICY.allowDisputed, true)
  expect.equal(DEFAULT_RECALL_ELIGIBILITY_POLICY.allowSupersededForHistorical, true)
})

test('describeVerdict 不含正文（隐私）', () => {
  const line = describeVerdict({ candidate: candidate(), verdict: verdictOf({}) })
  expect.notIncludes(line, '示例工程科技大学')
  expect.includes(line, 'ELIGIBLE')
})

// ===========================================================================
// 证据
// ===========================================================================

const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M5 WP2 Eligibility Filter')

mkdirSync(join(process.cwd(), 'artifacts', 'm5'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5', 'wp2-eligibility.json'),
  `${JSON.stringify(
    {
      testId: 'M5 / WP2 eligibility filter',
      generatedAt: new Date().toISOString(),
      passed: summary.passed,
      failed: summary.failed,
      failures: summary.failures.map((item) => item.name),
      cases: caseTable,
      matrix: matrixEvidence,
      reservedReasons: RESERVED_EXCLUSION_REASONS,
      leakage: {
        /** 混合 fixture 上**实测**的泄漏（全 0 才有意义） */
        measuredOnMixedFixture: measuredLeakage,
        /** 768 例穷举矩阵上**实测**的泄漏（全 0 才有意义） */
        measuredOnMatrix: matrixEvidence?.leakage,
        /**
         * 量具自检：故意制造泄漏后**实测**到的数字。
         * 它与上面两个全 0 必须**对照读** —— 一个永远返回 0 的计数器
         * 与一个真的没有泄漏的世界，在输出上完全一样（INV-M45-06）。
         */
        gaugeRespondsToInjectedLeak: gaugeSelfCheck,
        method:
          'measureLeakage() 统计"被放行却违反规则"的条数；' +
          'hardGate 判据 = measuredOnMixedFixture 与 measuredOnMatrix 的各项均为 0，' +
          '且 gaugeRespondsToInjectedLeak 的各项均 > 0',
      },
      hardGateVerdict:
        measuredLeakage !== undefined &&
        matrixEvidence !== undefined &&
        gaugeSelfCheck !== undefined &&
        Object.entries(measuredLeakage)
          .filter(([key]) => key !== 'totalEligible')
          .every(([, value]) => value === 0) &&
        Object.entries(matrixEvidence.leakage).every(([, value]) => value === 0) &&
        Object.entries(gaugeSelfCheck)
          .filter(([key]) => key !== 'totalEligible')
          .every(([, value]) => value > 0)
          ? 'PASS'
          : 'FAIL',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5/wp2-eligibility.json')

process.exit(summary.failed === 0 ? 0 : 1)
