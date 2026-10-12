/**
 * M9 WP2 —— 部件级测试门（`pnpm m9:test`）。
 *
 * ============================================================================
 *  本门测什么（计划 §13 WP2；全部离线、确定性、毫秒级）
 * ============================================================================
 *  ① 合同：七个 BELIEF_* payload 结构校验器——合法形状通过、篡改形状失败关闭
 *  ② 纯规则：B-REPORTED 白名单（对冻结语料逐条）、B-INFERRED 阈值、
 *     槽位键（value 不进键）、makeBeliefId 确定性与修订可区分
 *  ③ 状态机：独立 oracle 对**手写预期**的逐字段一致（WP2 冻结的预期机器；
 *     WP4 起同一批序列再喂生产 reducer，三方一致）
 *  ④ 静态边界：oracle 独立性（不 import 生产 reducer）、语料完整性
 *     （id 唯一 / expect 闭集 / measured_count > 0）、事件登记表接线
 *
 * ⚠️ 本门**不**实现任何 store / 调度 / 上下文接线（WP4+ 的事），
 *    也不打开任何数据库（纯函数 + 文本夹具）。
 *
 * 跑法：pnpm m9:test
 *       pnpm m9:test <过滤词>   # 只跑名字含它的
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'

import {
  BELIEF_DOMAIN_EVENT_TYPES,
  BELIEF_INFERRED_MIN_CONVERSATIONS,
  BELIEF_INFERRED_MIN_ROOTS,
  BELIEF_INFERRED_VALUES,
  createBeliefDomainEventRegistry,
  isBeliefReportedEligible,
  beliefInferredThresholdMet,
  beliefSlotKeyOf,
  makeBeliefId,
  validateBeliefDisputedPayload,
  validateBeliefEvidenceNotedPayload,
  validateBeliefFormedPayload,
  validateBeliefOriginPayload,
  validateBeliefReinforcedPayload,
  validateBeliefRetractedPayload,
  validateBeliefSupersededPayload,
  asCharacterId,
  asConversationEventId,
  asEntityId,
  entityRef,
  type BeliefOriginPayload,
} from '../src/kernel/contracts/index.ts'

import { oracleFold, oracleReopenIsLegal, oracleRootsForbidden } from '../evals/fixtures/m9/belief-oracle.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CHARACTER = asCharacterId('char_sumuwei')
const OWNER = asEntityId('char_sumuwei')
const SUBJECT = entityRef('user', 'user_alex')
const SLOT = beliefSlotKeyOf({
  perspectiveOwnerId: OWNER,
  subject: SUBJECT,
  predicate: 'interaction.explanation_detail',
  scopeKey: 'technical_explanation',
})

interface InferredSample {
  id: string
  value: string
  expect: 'note' | 'silent'
  text: string
  note?: string
}

interface ReportedSample {
  id: string
  expect: 'eligible' | 'ineligible'
  memoryType: string
  authority: string
  epistemicStatus: string
  status: string
  note?: string
}

interface BeliefCorpus {
  schemaVersion: number
  family: string
  inferred: InferredSample[]
  reported: ReportedSample[]
}

function loadCorpus(): BeliefCorpus {
  const path = join(process.cwd(), 'evals', 'fixtures', 'm9', 'belief-rule-corpus.json')
  return JSON.parse(readFileSync(path, 'utf8')) as BeliefCorpus
}

function validOriginPayload(): BeliefOriginPayload {
  return {
    characterId: CHARACTER,
    activationId: 'act-test-1',
    cutoverSequence: 117,
    cutoverAt: 1_769_000_000_000,
    policyVersion: 'belief-policy@1',
  }
}

function validFormedPayload(): Record<string, unknown> {
  return {
    characterId: CHARACTER,
    beliefId: makeBeliefId(CHARACTER, SLOT, '42'),
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    proposition: {
      predicate: 'interaction.explanation_detail',
      value: 'detailed',
      scopeKey: 'technical_explanation',
    },
    epistemicKind: 'inferred',
    supportLevel: 'tentative',
    evidenceRootIds: [
      asConversationEventId('cev:char_sumuwei:dm-1:101'),
      asConversationEventId('cev:char_sumuwei:dm-1:102'),
      asConversationEventId('cev:char_sumuwei:dm-2:7'),
    ],
    // B-INFERRED 无 Memory 依赖：字段省略（空集合用 undefined，不用 []——校验器纪律）
    ruleId: 'belief-inferred-explanation-detail',
    ruleVersion: 'belief-inferred-rules@1',
  }
}

// ===========================================================================
// ① 合同：payload 结构校验（失败关闭）
// ===========================================================================
group('① 合同 · payload 结构校验')

test('七个 BELIEF_* 事件全部登记且 payload 校验接线', () => {
  const registry = createBeliefDomainEventRegistry()
  expect.deepEqual(
    registry.types().sort(),
    [...BELIEF_DOMAIN_EVENT_TYPES].sort(),
    '登记表 = 七事件闭集',
  )
  for (const type of BELIEF_DOMAIN_EVENT_TYPES) {
    expect.ok(registry.get(type) !== undefined, `${type} 必须可从登记表取出`)
  }
})

test('BELIEF_ORIGIN：合法通过；篡改失败关闭', () => {
  expect.equal(
    validateBeliefOriginPayload(validOriginPayload()).cutoverSequence,
    117,
    '合法 origin 必须原样通过',
  )
  let threw = false
  try {
    validateBeliefOriginPayload({ ...validOriginPayload(), cutoverSequence: -1 })
  } catch {
    threw = true
  }
  expect.ok(threw, '负 cutoverSequence 必须抛（失败关闭）')
  threw = false
  try {
    validateBeliefOriginPayload({ ...validOriginPayload(), policyVersion: '' })
  } catch {
    threw = true
  }
  expect.ok(threw, '空 policyVersion 必须抛')
})

test('BELIEF_EVIDENCE_NOTED：合法通过；缺根引用失败关闭', () => {
  const payload = {
    characterId: CHARACTER,
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    predicate: 'interaction.explanation_detail',
    scopeKey: 'technical_explanation',
    value: 'detailed',
    rootEventId: asConversationEventId('cev:char_sumuwei:dm-1:101'),
    rootSequence: 101,
    conversationId: 'dm-1',
    ruleId: 'belief-inferred-explanation-detail',
    ruleVersion: 'belief-inferred-rules@1',
  }
  expect.equal(
    validateBeliefEvidenceNotedPayload(payload).rootSequence,
    101,
    '合法证据引用必须通过',
  )
  let threw = false
  try {
    validateBeliefEvidenceNotedPayload({ ...payload, rootEventId: '' })
  } catch {
    threw = true
  }
  expect.ok(threw, '空 rootEventId 必须抛（证据引用不可伪造为空）')
})

test('BELIEF_FORMED：合法通过；epistemicKind 自报提升失败关闭', () => {
  const payload = validFormedPayload()
  expect.equal(
    validateBeliefFormedPayload(payload).epistemicKind,
    'inferred',
    '合法 formed 必须通过',
  )
  let threw = false
  try {
    // 闭集外的新造档位（'reported' 本身是合法值——"inferred 不许自报提升为
    // reported"是 WP4 Validator 的业务规则，结构层只守闭集）
    validateBeliefFormedPayload({ ...payload, epistemicKind: 'asserted' })
  } catch {
    threw = true
  }
  expect.ok(threw, 'epistemicKind 不在闭集必须抛（INV-M9-03 的结构半边）')
  threw = false
  try {
    validateBeliefFormedPayload({ ...payload, evidenceRootIds: [] })
  } catch {
    threw = true
  }
  expect.ok(threw, '空根集合必须抛（无来源判断不可形成）')
})

test('BELIEF_REINFORCED：合法通过；空 newRootIds 失败关闭', () => {
  const payload = {
    characterId: CHARACTER,
    beliefId: makeBeliefId(CHARACTER, SLOT, '42'),
    newRootIds: [asConversationEventId('cev:char_sumuwei:dm-3:5')],
    ruleId: 'belief-inferred-explanation-detail',
    ruleVersion: 'belief-inferred-rules@1',
  }
  expect.equal(
    validateBeliefReinforcedPayload(payload).newRootIds.length,
    1,
    '合法强化必须通过',
  )
  let threw = false
  try {
    validateBeliefReinforcedPayload({ ...payload, newRootIds: [] })
  } catch {
    threw = true
  }
  expect.ok(threw, '空 newRootIds 必须抛（去重后为空的强化是噪音，不是事件）')
})

test('BELIEF_DISPUTED / BELIEF_SUPERSEDED：合法通过；缺因果链失败关闭', () => {
  const disputed = validateBeliefDisputedPayload({
    characterId: CHARACTER,
    beliefId: makeBeliefId(CHARACTER, SLOT, '42'),
    reason: '同槽位同时间互斥值',
    ruleId: 'belief-policy@1',
    ruleVersion: 'belief-policy@1',
  })
  expect.ok(disputed.reason.length > 0, '合法争议必须通过')
  const superseded = validateBeliefSupersededPayload({
    characterId: CHARACTER,
    oldBeliefId: makeBeliefId(CHARACTER, SLOT, '42'),
    newBeliefId: makeBeliefId(CHARACTER, SLOT, '43'),
    reason: '用户更正',
    validTo: 1_769_000_000_000,
    ruleId: 'belief-policy@1',
    ruleVersion: 'belief-policy@1',
  })
  expect.ok(String(superseded.oldBeliefId) !== String(superseded.newBeliefId), 'old/new 必须可区分')
  let threw = false
  try {
    validateBeliefSupersededPayload({
      characterId: CHARACTER,
      oldBeliefId: makeBeliefId(CHARACTER, SLOT, '42'),
      newBeliefId: makeBeliefId(CHARACTER, SLOT, '42'),
      reason: '自我取代',
      validTo: 1_769_000_000_000,
      ruleId: 'belief-policy@1',
      ruleVersion: 'belief-policy@1',
    })
  } catch {
    threw = true
  }
  expect.notOk(threw, '结构层不拒同 id 取代（业务规则在 Validator；本层只管形状）')
})

test('BELIEF_RETRACTED：合法通过；reason 闭集外失败关闭', () => {
  const payload = {
    characterId: CHARACTER,
    beliefId: makeBeliefId(CHARACTER, SLOT, '42'),
    reason: 'user_forget_request',
    forbiddenRootIds: [asConversationEventId('cev:char_sumuwei:dm-1:101')],
    ruleId: 'belief-policy@1',
    ruleVersion: 'belief-policy@1',
  }
  expect.equal(
    (validateBeliefRetractedPayload(payload).forbiddenRootIds ?? []).length,
    1,
    '合法撤回必须通过',
  )
  let threw = false
  try {
    validateBeliefRetractedPayload({ ...payload, reason: 'because_i_said_so' })
  } catch {
    threw = true
  }
  expect.ok(threw, 'reason 闭集外必须抛（撤回理由可判，不许自由文本）')
})

// ===========================================================================
// ② 纯规则：白名单 / 阈值 / 槽位键 / id
// ===========================================================================
group('② 纯规则 · 白名单与冻结值')

test('B-REPORTED 白名单对冻结语料逐条一致（正负双向计数 > 0）', () => {
  const corpus = loadCorpus()
  let eligibleCount = 0
  let ineligibleCount = 0
  for (const sample of corpus.reported) {
    const actual = isBeliefReportedEligible({
      type: sample.memoryType as never,
      authority: sample.authority as never,
      epistemicStatus: sample.epistemicStatus,
      status: sample.status,
    })
    if (sample.expect === 'eligible') {
      eligibleCount += 1
      expect.ok(actual, `${sample.id}：白名单内 Memory 必须合格（${sample.note ?? ''}）`)
    } else {
      ineligibleCount += 1
      expect.notOk(actual, `${sample.id}：白名单外 Memory 必须不合格（${sample.note ?? ''}）`)
    }
  }
  // measured_count 纪律（AGENTS §6.8）：两个方向的分母都必须 > 0
  expect.ok(eligibleCount > 0, `正控计数必须 > 0（实测 ${eligibleCount}）`)
  expect.ok(ineligibleCount > 0, `负控计数必须 > 0（实测 ${ineligibleCount}）`)
})

test('B-INFERRED 阈值：≥3 独立根 · 跨 ≥2 会话（边界两侧都有读数）', () => {
  const cev = (n: number) => asConversationEventId(`cev:char_sumuwei:dm-x:${n}`)
  expect.notOk(
    beliefInferredThresholdMet({
      rootIds: [cev(1), cev(2)],
      conversationIds: ['dm-1', 'dm-2'],
    }),
    '2 根不达标（差 1 根）',
  )
  expect.notOk(
    beliefInferredThresholdMet({
      rootIds: [cev(1), cev(2), cev(3)],
      conversationIds: ['dm-1'],
    }),
    '单会话不达标（跨会话判据独立成立）',
  )
  expect.ok(
    beliefInferredThresholdMet({
      rootIds: [cev(1), cev(2), cev(3)],
      conversationIds: ['dm-1', 'dm-2'],
    }),
    '3 根 + 2 会话达标',
  )
  expect.equal(BELIEF_INFERRED_MIN_ROOTS, 3, '冻结值：最少独立根 = 3')
  expect.equal(BELIEF_INFERRED_MIN_CONVERSATIONS, 2, '冻结值：最少会话 = 2')
})

test('槽位键：value 不进键；同实体不同 kind 键不同（B07）', () => {
  const keyDetailed = beliefSlotKeyOf({
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    predicate: 'interaction.explanation_detail',
    scopeKey: 'technical_explanation',
  })
  const keyConcise = beliefSlotKeyOf({
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    predicate: 'interaction.explanation_detail',
    scopeKey: 'technical_explanation',
  })
  expect.equal(keyDetailed, keyConcise, '同槽位不同 value ⇒ 同键（D03：value 不进键）')

  const keyOtherScope = beliefSlotKeyOf({
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    predicate: 'interaction.explanation_detail',
    scopeKey: 'casual_chat',
  })
  expect.notOk(keyDetailed === keyOtherScope, '不同 scopeKey ⇒ 不同键')

  const keyObjectKind = beliefSlotKeyOf({
    perspectiveOwnerId: OWNER,
    subject: entityRef('object', 'user_alex'),
    predicate: 'interaction.explanation_detail',
    scopeKey: 'technical_explanation',
  })
  expect.notOk(keyDetailed === keyObjectKind, '同 id 不同 kind ⇒ 不同键（B07）')

  const keyOtherOwner = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId('char_B'),
    subject: SUBJECT,
    predicate: 'interaction.explanation_detail',
    scopeKey: 'technical_explanation',
  })
  expect.notOk(keyDetailed === keyOtherOwner, '不同视角所有者 ⇒ 不同键（perspective 语义）')
})

test('makeBeliefId：确定性 + 修订可区分（INV-M9-11）', () => {
  const a = makeBeliefId(CHARACTER, SLOT, '42')
  const b = makeBeliefId(CHARACTER, SLOT, '42')
  const c = makeBeliefId(CHARACTER, SLOT, '43')
  expect.equal(String(a), String(b), '同输入同 id（幂等）')
  expect.notOk(a === c, '不同 formationKey ⇒ 不同 id（修订不抹历史）')
  expect.ok(String(a).startsWith('blf:char_sumuwei:'), 'id 形状：blf:<character>:<slotHash>:<formation>')
  let threw = false
  try {
    makeBeliefId(CHARACTER, SLOT, '带空格的 key!')
  } catch {
    threw = true
  }
  expect.ok(threw, '非法 formationKey 必须抛（id 里的字符白名单）')
})

test('B-INFERRED 取值闭集逐字冻结（D05）', () => {
  expect.deepEqual(
    [...BELIEF_INFERRED_VALUES],
    ['detailed', 'concise'],
    '闭集 = detailed | concise（扩值 = 新规则版本）',
  )
})

// ===========================================================================
// ③ 状态机：oracle 对手写预期（WP2 冻结的预期机器）
// ===========================================================================
group('③ 状态机 · 独立 oracle 对手写预期')

test('FORMED → active；同 id 重放 = no-op（幂等）', () => {
  const fold = oracleFold([
    { kind: 'origin', activationId: 'act-1', cutoverSequence: 117 },
    {
      kind: 'formed',
      beliefId: 'b1',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
    {
      kind: 'formed',
      beliefId: 'b1',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
  ])
  expect.ok(fold.originated, '建档生效')
  // 手写预期：active · 3 根 · 重放不增
  expect.equal(fold.beliefs['b1']!.status, 'active')
  expect.equal(fold.beliefs['b1']!.roots.length, 3)
  expect.deepEqual(fold.beliefs['b1']!.roots, ['r1', 'r2', 'r3'])
})

test('REINFORCED：去重后才计入（INV-M9-08）', () => {
  const fold = oracleFold([
    {
      kind: 'formed',
      beliefId: 'b1',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
    { kind: 'reinforced', beliefId: 'b1', newRoots: ['r1', 'r4'] },
    { kind: 'reinforced', beliefId: 'b1', newRoots: ['r1', 'r2', 'r3'] },
  ])
  // 手写预期：3 + 1（r4）= 4；全重复的那次不增
  expect.equal(fold.beliefs['b1']!.roots.length, 4)
  expect.deepEqual(fold.beliefs['b1']!.roots, ['r1', 'r2', 'r3', 'r4'])
})

test('DISPUTED：active → disputed；disputed 上强化 = no-op', () => {
  const fold = oracleFold([
    {
      kind: 'formed',
      beliefId: 'b1',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
    { kind: 'disputed', beliefId: 'b1' },
    { kind: 'reinforced', beliefId: 'b1', newRoots: ['r9'] },
    { kind: 'disputed', beliefId: 'b1' },
  ])
  expect.equal(fold.beliefs['b1']!.status, 'disputed', '争议态保留')
  expect.equal(fold.beliefs['b1']!.roots.length, 3, '争议态不加支持（不投票决胜）')
})

test('SUPERSEDED：old 终态；后续事件 no-op', () => {
  const fold = oracleFold([
    {
      kind: 'formed',
      beliefId: 'old',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
    {
      kind: 'formed',
      beliefId: 'new',
      slotKey: SLOT,
      epistemicKind: 'reported',
      roots: ['r7'],
    },
    { kind: 'superseded', oldBeliefId: 'old', newBeliefId: 'new' },
    { kind: 'reinforced', beliefId: 'old', newRoots: ['r8'] },
    { kind: 'disputed', beliefId: 'old' },
  ])
  expect.equal(fold.beliefs['old']!.status, 'superseded', '被取代 = 终态')
  expect.equal(fold.beliefs['old']!.roots.length, 3, '终态上强化 no-op')
  expect.equal(fold.beliefs['new']!.status, 'active', '新条保持自身状态')
})

test('RETRACTED：终态 + forbiddenRoots 累积；重放不复活（B28）', () => {
  const fold = oracleFold([
    {
      kind: 'formed',
      beliefId: 'b1',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
    { kind: 'retracted', beliefId: 'b1', slotKey: SLOT, forbiddenRoots: ['r1', 'r2', 'r3'] },
    { kind: 'reinforced', beliefId: 'b1', newRoots: ['r1'] },
    { kind: 'disputed', beliefId: 'b1' },
  ])
  expect.equal(fold.beliefs['b1']!.status, 'retracted', '撤回 = 终态')
  expect.equal(fold.beliefs['b1']!.roots.length, 3, '终态上重放旧证据不复活（B28）')
  expect.deepEqual(
    fold.forbiddenRootsBySlot[SLOT],
    ['r1', 'r2', 'r3'],
    '禁用根按槽位累积（§5.4）',
  )
})

test('遗忘契约：相交根提案必判禁；新根新身份合法重开（§5.4）', () => {
  const fold = oracleFold([
    {
      kind: 'formed',
      beliefId: 'b1',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r1', 'r2', 'r3'],
    },
    { kind: 'retracted', beliefId: 'b1', slotKey: SLOT, forbiddenRoots: ['r1', 'r2', 'r3'] },
    {
      kind: 'formed',
      beliefId: 'b2',
      slotKey: SLOT,
      epistemicKind: 'inferred',
      roots: ['r4', 'r5', 'r6'],
    },
  ])
  // 手写预期：旧根相交 ⇒ 禁；全新根 ⇒ 合法重开
  expect.ok(oracleRootsForbidden(fold, SLOT, ['r1']), '旧根复活必须被判禁')
  expect.ok(oracleRootsForbidden(fold, SLOT, ['r9', 'r2']), '部分相交也判禁')
  expect.notOk(oracleRootsForbidden(fold, SLOT, ['r4', 'r5']), '全新根不禁')
  expect.ok(oracleReopenIsLegal(fold, SLOT, 'b2', ['r4', 'r5', 'r6']), '新身份 + 新根 = 合法重开')
  expect.notOk(oracleReopenIsLegal(fold, SLOT, 'b2', ['r1']), '新身份 + 旧根 = 不合法')
})

// ===========================================================================
// ④ 静态边界：oracle 独立性 + 语料完整性
// ===========================================================================
group('④ 静态边界 · 独立性与语料完整性')

test('oracle 独立性：不 import 生产 reducer（WP2 任务 6 的机器判据）', () => {
  const oracleSource = readFileSync(
    join(process.cwd(), 'evals', 'fixtures', 'm9', 'belief-oracle.ts'),
    'utf8',
  )
  // 独立性 = 无 **import 依赖**（注释里提及生产文件是合法的文档行为）：
  // 只扫 import/require 行，不扫全文——否则探测器会把"说明自己为何独立"的
  // 注释误判成违规（量具校准第一轮的真实发现）。
  const importLines = oracleSource
    .split('\n')
    .filter((line) => /^\s*(import\b|.*\brequire\s*\()/.test(line))
  expect.deepEqual(
    importLines,
    [],
    'oracle 必须零 import（纯手写预期机器，不共享任何生产代码）',
  )
  expect.notOk(
    importLines.some((line) => line.includes('projections')),
    'oracle 不得 import 生产 reducer（同义反复守卫）',
  )
  expect.notOk(
    importLines.some((line) => line.includes('kernel/')),
    'oracle 不得依赖 kernel 任何模块（零共享代码）',
  )
})

test('语料完整性：id 唯一 / expect 闭集 / 双向计数 > 0（measured_count 纪律）', () => {
  const corpus = loadCorpus()
  expect.equal(corpus.family, 'm9-belief-rule-corpus@1', '语料族名冻结')

  const allIds = [...corpus.inferred.map((s) => s.id), ...corpus.reported.map((s) => s.id)]
  expect.equal(new Set(allIds).size, allIds.length, '样本 id 全局唯一')

  const inferredExpects = new Set(corpus.inferred.map((s) => s.expect))
  expect.deepEqual(
    [...inferredExpects].sort(),
    ['note', 'silent'],
    'inferred.expect 闭集 = note | silent',
  )
  const reportedExpects = new Set(corpus.reported.map((s) => s.expect))
  expect.deepEqual(
    [...reportedExpects].sort(),
    ['eligible', 'ineligible'],
    'reported.expect 闭集 = eligible | ineligible',
  )

  const noteCount = corpus.inferred.filter((s) => s.expect === 'note').length
  const silentCount = corpus.inferred.filter((s) => s.expect === 'silent').length
  expect.ok(noteCount > 0, `inferred 正控必须 > 0（实测 ${noteCount}）`)
  expect.ok(silentCount > 0, `inferred 负控必须 > 0（实测 ${silentCount}）`)
  const detailedCount = corpus.inferred.filter((s) => s.value === 'detailed' && s.expect === 'note').length
  const conciseCount = corpus.inferred.filter((s) => s.value === 'concise' && s.expect === 'note').length
  expect.ok(detailedCount > 0, `detailed 正控必须 > 0（实测 ${detailedCount}）`)
  expect.ok(conciseCount > 0, `concise 正控必须 > 0（实测 ${conciseCount}）`)

  expect.ok(corpus.inferred.length >= 40, `inferred 语料规模 ≥ 40（实测 ${corpus.inferred.length}）`)
  expect.ok(corpus.reported.length >= 10, `reported 语料规模 ≥ 10（实测 ${corpus.reported.length}）`)
})

// ---------------------------------------------------------------------------
const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M9 部件测试（合同 / 纯规则 / 状态机 / 静态边界）')
process.exit(summary.failed === 0 ? 0 : 1)
