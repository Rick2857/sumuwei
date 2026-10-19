/**
 * M9 WP3 门 —— 产出者（评估器）+ 判据一致性 + 变更流增量读（`pnpm m9:source:verify`）。
 *
 * ============================================================================
 *  四段判据（全部机器读数；正控/负控成对）
 * ============================================================================
 * §1 语料一致性：冻结规则表（belief-inferred-rules@1）对冻结语料逐条判定——
 *    正控召回必须 **20/20**，近邻负控误触发必须 **0/20**（验收契约 §2：
 *    判据的权威源是语料，不是"看起来合理"）。measured_count 双向 > 0。
 * §2 评估器资格：证据资格四条（user_message + ESTABLISHED + active user +
 *    切换后）逐条负控 + 会话维度缺失失败关闭（具名 abstain）。
 * §3 形成生命周期提案：阈值边界两侧（3 根 2 会话形成 / 3 根 1 会话不形成）、
 *    同值强化（去重后非空才提）、同值无新根幂等静默、异值冲突信号照提 FORMED、
 *    formationKey 确定性（幂等重放同 beliefId）。
 * §4 afterSequence 增量读（隔离库集成）：严格大于语义 + 与 beforeSequence
 *    组合成开区间 + 不带选项的读法与既有语义逐字一致（追加不改旧）。
 *
 * ⚠️ §4 用 `isolateDatabase()` 一次性沙箱；真实库从不被打开。
 *
 * 跑法：pnpm m9:source:verify
 */

import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9-source-verify', { keep: false })



import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import {
  asCharacterId,
  asConversationEventId,
  asConversationId,
  asEntityId,
  entityRef,
  type ConversationEventId,
  type ProcessorEventView,
} from '../src/kernel/contracts/index.ts'
import {
  BELIEF_INFERRED_MIN_CONVERSATIONS,
  BELIEF_INFERRED_MIN_ROOTS,
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_RULE_ID,
  BELIEF_INFERRED_SCOPE,
  beliefSlotKeyOf,
  validateBeliefEvidenceNotedPayload,
  type BeliefEvidenceAccumulation,
  type BeliefEvidenceNotedPayload,
} from '../src/kernel/contracts/belief.ts'
import {
  RuleBasedBeliefEvaluator,
  type BeliefEvaluationInput,
  type BeliefEvidencePolicy,
  type BeliefSlotSnapshot,
} from '../src/kernel/app/belief/evaluator.ts'
import { judgeExplanationDetail } from '../src/kernel/app/belief/patterns.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CHARACTER = asCharacterId('char_sumuwei')
const OWNER = asEntityId('char_sumuwei')
const USER = asEntityId('user_alex')
const SUBJECT = entityRef('user', 'user_alex')
const NOW = 1_800_000_000_000

const ESTABLISHED_ORIGIN = {
  attributionOrigin: 'RECORDED',
  contentOriginator: { state: 'KNOWN', value: { kind: 'USER', id: USER } },
  axisBConfirmed: true,
} as const

const POLICY: BeliefEvidencePolicy = { activeUserId: USER, cutoverSequence: 100 }

interface InferredSample {
  id: string
  value: string
  expect: string
  text: string
}

function userView(
  id: string,
  content: string,
  sequence: number,
  conversationId: string,
  trustedOrigin: ProcessorEventView['trustedOrigin'] = ESTABLISHED_ORIGIN,
  overrides: Partial<ProcessorEventView> = {},
): ProcessorEventView {
  return {
    id: asConversationEventId(id),
    sequence,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: String(USER),
    content,
    createdAt: NOW,
    conversationId: asConversationId(conversationId),
    ...(trustedOrigin !== undefined ? { trustedOrigin } : {}),
    ...overrides,
  }
}

function baseInput(
  views: readonly ProcessorEventView[],
  slotState?: BeliefSlotSnapshot,
  policyOverride?: Partial<BeliefEvidencePolicy>,
): BeliefEvaluationInput {
  return {
    characterId: CHARACTER,
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    views,
    policy: { ...POLICY, ...policyOverride },
    ...(slotState !== undefined ? { slotState } : {}),
  }
}

const CTX = { processorName: 'm9-source-verify', processorVersion: 'm9-source-verify@1' as const }

const evaluator = new RuleBasedBeliefEvaluator()

// 正控文本（detailed / concise 各一，来自冻结语料的设计意图）
const D_TEXT = '以后技术的东西就照这样讲，一步步来，我跟着不走丢'
const C_TEXT = '太啰嗦了，直接说重点，我不需要那么多铺垫'

// ---------------------------------------------------------------------------
// 判据执行器
// ---------------------------------------------------------------------------

interface Check {
  section: string
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
let sectionName = ''

function section(title: string): void {
  sectionName = title
  console.log(`\n=== ${title} ===`)
}

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ section: sectionName, name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name} :: ${detail}`)
}

async function main(): Promise<void> {
  // =========================================================================
  // §1 语料一致性（冻结规则表 vs 冻结语料；判据的权威源）
  // =========================================================================
  section('§1 语料一致性（belief-inferred-rules@1 vs 冻结语料）')

  const corpus = JSON.parse(
    readFileSync(join(REPO_ROOT, 'evals', 'fixtures', 'm9', 'belief-rule-corpus.json'), 'utf8'),
  ) as { inferred: InferredSample[] }
  const inferred = corpus.inferred

  const positives = inferred.filter((s) => s.expect === 'note')
  const negatives = inferred.filter((s) => s.expect === 'silent')

  // measured_count 纪律（AGENTS §6.8）：两个方向的分母都必须 > 0
  check(
    'measured_count：正控 > 0 且负控 > 0（0 检查 ≠ PASS）',
    positives.length >= 20 && negatives.length >= 20,
    `positives=${String(positives.length)} · negatives=${String(negatives.length)}`,
  )

  const missed = positives.filter((s) => judgeExplanationDetail(s.text).value !== s.value)
  check(
    '正控召回 100%（漏一条 = 判据与语料脱钩）',
    missed.length === 0,
    `${String(positives.length - missed.length)}/${String(positives.length)}${
      missed.length > 0 ? ` · 漏判：${missed.map((s) => s.id).join(',')}` : ''
    }`,
  )

  const falseFired = negatives.filter((s) => judgeExplanationDetail(s.text).value !== undefined)
  check(
    '近邻负控误触发 0%（守卫先行；负控清单见语料 note 字段）',
    falseFired.length === 0,
    `${String(falseFired.length)}/${String(negatives.length)}${
      falseFired.length > 0 ? ` · 误触发：${falseFired.map((s) => s.id).join(',')}` : ''
    }`,
  )

  // 守卫优先于正控的机器证明：负控里含正控词形的条目必须被守卫拦下
  const trapLike = negatives.filter((s) =>
    /啰嗦|详细|简洁|重点|细/.test(s.text),
  )
  const trapHeld = trapLike.filter((s) => judgeExplanationDetail(s.text).value === undefined)
  check(
    '守卫优先于正控（含正控词形的负控必须被守卫拦下）',
    trapLike.length > 0 && trapHeld.length === trapLike.length,
    `${String(trapHeld.length)}/${String(trapLike.length)} 条词形陷阱全拦`,
  )

  // =========================================================================
  // §2 评估器资格（四条 + 会话维度失败关闭）
  // =========================================================================
  section('§2 证据资格（四条逐条负控 + 会话维度失败关闭）')

  const s1 = await evaluator.process(baseInput([userView('cev:c:dm-1:101', D_TEXT, 101, 'dm-1')]), CTX)
  check(
    '正控：ESTABLISHED 用户消息（详略信号）⇒ 1 EVIDENCE_NOTED',
    s1.proposals.length === 1 &&
      s1.proposals[0].targetEvents[0].type === 'BELIEF_EVIDENCE_NOTED',
    `proposals=${String(s1.proposals.length)} · noted=${String(s1.notedCount)}`,
  )

  const s2 = await evaluator.process(
    baseInput([
      userView('cev:c:dm-1:102', D_TEXT, 102, 'dm-1', ESTABLISHED_ORIGIN, {
        type: 'assistant_message',
        actorType: 'character',
      }),
    ]),
    CTX,
  )
  check(
    '负控①：assistant_message（她的生成含同词形）⇒ 0 提案（生成不驱动信念）',
    s2.proposals.length === 0,
    `proposals=${String(s2.proposals.length)}`,
  )

  const s3 = await evaluator.process(
    // 显式构造无信封视图：不能走 userView(..., undefined)——默认参数会把
    // undefined 换成 ESTABLISHED_ORIGIN（量具校准第一轮的真实发现）
    baseInput([
      {
        id: asConversationEventId('cev:c:dm-1:103'),
        sequence: 103,
        conversationSequence: 1,
        type: 'user_message',
        actorType: 'user',
        actorId: String(USER),
        content: D_TEXT,
        createdAt: NOW,
        conversationId: asConversationId('dm-1'),
      },
    ]),
    CTX,
  )
  check(
    '负控②：无受信信封（来源未确立）⇒ 0 提案（失败关闭）',
    s3.proposals.length === 0,
    `proposals=${String(s3.proposals.length)}`,
  )

  const otherUserOrigin = {
    attributionOrigin: 'RECORDED',
    contentOriginator: { state: 'KNOWN', value: { kind: 'USER', id: asEntityId('user_other') } },
    axisBConfirmed: true,
  } as const
  const s4 = await evaluator.process(
    baseInput([userView('cev:c:dm-1:104', D_TEXT, 104, 'dm-1', otherUserOrigin)]),
    CTX,
  )
  check(
    '负控③：归因主体 ≠ active user ⇒ 0 提案（M8-D11 同款单用户边界）',
    s4.proposals.length === 0,
    `proposals=${String(s4.proposals.length)}`,
  )

  const s5 = await evaluator.process(
    baseInput([userView('cev:c:dm-1:99', D_TEXT, 99, 'dm-1')], undefined, {
      cutoverSequence: 100,
    }),
    CTX,
  )
  check(
    '负控④a：sequence ≤ cutoverSequence（切换前历史）⇒ 0 提案（不回评）',
    s5.proposals.length === 0,
    `proposals=${String(s5.proposals.length)}`,
  )

  const s6 = await evaluator.process(
    baseInput([userView('cev:c:dm-1:105', D_TEXT, 105, 'dm-1')], undefined, {
      cutoverSequence: null,
    }),
    CTX,
  )
  check(
    '负控④b：cutoverSequence = null（尚未建档）⇒ 0 提案（全部拒绝）',
    s6.proposals.length === 0,
    `proposals=${String(s6.proposals.length)}`,
  )

  const noConvView: ProcessorEventView = {
    ...userView('cev:c:dm-1:106', D_TEXT, 106, 'dm-1'),
  }
  delete (noConvView as { conversationId?: unknown }).conversationId
  const s7 = await evaluator.process(baseInput([noConvView]), CTX)
  check(
    '失败关闭：会话维度缺失 ⇒ 0 提案 + 具名 abstain（不猜会话）',
    s7.proposals.length === 0 &&
      s7.abstentions.some((a) => a.reason === 'missing_conversation_dimension'),
    `proposals=${String(s7.proposals.length)} · abstain=${String(s7.abstentions[0]?.reason)}`,
  )

  const s8 = await evaluator.process(
    baseInput([userView('cev:c:dm-1:107', '今天天气不错', 107, 'dm-1')]),
    CTX,
  )
  check(
    '无信号：普通对话 ⇒ 0 提案 + 具名 abstain no_style_signal（"不推动信念"是正常结论）',
    s8.proposals.length === 0 &&
      s8.abstentions.some((a) => a.reason === 'no_style_signal'),
    `proposals=${String(s8.proposals.length)} · abstain=${String(s8.abstentions[0]?.reason)}`,
  )

  const s9 = await evaluator.process(
    baseInput([userView('cev:c:dm-1:108', '他说你讲得太啰嗦，让我提醒你', 108, 'dm-1')]),
    CTX,
  )
  check(
    '守卫具名：代述形（他说…啰嗦）⇒ abstain third_party_report（词形在内、证据在外）',
    s9.proposals.length === 0 &&
      s9.abstentions.some((a) => a.reason === 'third_party_report'),
    `abstain=${String(s9.abstentions[0]?.reason)} · guard=${String(s9.abstentions[0]?.guardId)}`,
  )

  // =========================================================================
  // §3 形成生命周期提案（阈值边界 + 强化 + 冲突信号 + 幂等）
  // =========================================================================
  section('§3 形成生命周期提案')

  const formationViews = [
    userView('cev:c:dm-1:201', D_TEXT, 201, 'dm-1'),
    userView('cev:c:dm-1:202', D_TEXT, 202, 'dm-1'),
    userView('cev:c:dm-2:203', D_TEXT, 203, 'dm-2'),
  ]
  const f1 = await evaluator.process(baseInput(formationViews), CTX)
  const formed = f1.proposals.filter((p) => p.targetEvents[0].type === 'BELIEF_FORMED')
  check(
    '阈值达成：3 独立根 × 2 会话 ⇒ EVIDENCE_NOTED×3 + FORMED×1',
    f1.proposals.length === 4 && formed.length === 1,
    `proposals=${String(f1.proposals.length)} · formed=${String(formed.length)}`,
  )

  const beliefId = String(
    (formed[0].targetEvents[0].payload as { beliefId: string }).beliefId,
  )
  const slotKey = beliefSlotKeyOf({
    perspectiveOwnerId: OWNER,
    subject: SUBJECT,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
  })
  check(
    'beliefId 确定性：makeBeliefId(character, slotKey, formationKey=maxSeq) 可复算',
    beliefId === String(
      // formationKey = 形成时合并根的最大 sequence（203）
      (await import('../src/kernel/contracts/belief.ts')).makeBeliefId(CHARACTER, slotKey, '203'),
    ),
    `beliefId=${beliefId.slice(0, 34)}…`,
  )

  const f2 = await evaluator.process(baseInput(formationViews), CTX)
  const formed2 = f2.proposals.filter((p) => p.targetEvents[0].type === 'BELIEF_FORMED')
  check(
    '幂等：同输入重放 ⇒ 同 beliefId（重试不产生第二条信念身份）',
    formed2.length === 1 &&
      String((formed2[0].targetEvents[0].payload as { beliefId: string }).beliefId) === beliefId,
    `beliefId 相同=${String(
      String((formed2[0].targetEvents[0].payload as { beliefId: string }).beliefId) === beliefId,
    )}`,
  )

  const singleConvViews = [
    userView('cev:c:dm-1:211', D_TEXT, 211, 'dm-1'),
    userView('cev:c:dm-1:212', D_TEXT, 212, 'dm-1'),
    userView('cev:c:dm-1:213', D_TEXT, 213, 'dm-1'),
  ]
  const f3 = await evaluator.process(baseInput(singleConvViews), CTX)
  check(
    '阈值未达（单会话）：3 根 × 1 会话 ⇒ 只记证据不形成（跨会话判据独立成立）',
    f3.proposals.every((p) => p.targetEvents[0].type === 'BELIEF_EVIDENCE_NOTED'),
    `formed=${String(f3.proposals.filter((p) => p.targetEvents[0].type === 'BELIEF_FORMED').length)}`,
  )

  // 同值现存信念 + 新根 ⇒ REINFORCED
  const activeSame = {
    beliefId: (await import('../src/kernel/contracts/belief.ts')).makeBeliefId(
      CHARACTER,
      slotKey,
      '203',
    ),
    value: 'detailed' as const,
    rootIds: formationViews.map((v) => v.id),
  }
  const reinforceViews = [userView('cev:c:dm-3:221', D_TEXT, 221, 'dm-3')]
  const f4 = await evaluator.process(
    baseInput(reinforceViews, { activeBelief: activeSame }),
    CTX,
  )
  const reinforced = f4.proposals.filter((p) => p.targetEvents[0].type === 'BELIEF_REINFORCED')
  check(
    '同值现存 + 新根 ⇒ REINFORCED（operation=reinforce；newRootIds 去重后非空）',
    reinforced.length === 1 &&
      (reinforced[0].targetEvents[0].payload as { newRootIds: ConversationEventId[] }).newRootIds
        .length === 1,
    `reinforced=${String(reinforced.length)}`,
  )

  // 同值现存 + 已含根 ⇒ 幂等静默（无 REINFORCED、无 FORMED）
  const f5 = await evaluator.process(
    baseInput([formationViews[0]], { activeBelief: activeSame }),
    CTX,
  )
  check(
    '同值现存 + 根已在信念内 ⇒ 幂等静默（只记证据，不重复强化）',
    f5.proposals.every((p) => p.targetEvents[0].type === 'BELIEF_EVIDENCE_NOTED'),
    `non-evidence=${String(
      f5.proposals.filter((p) => p.targetEvents[0].type !== 'BELIEF_EVIDENCE_NOTED').length,
    )}`,
  )

  // 异值现存 + 阈值达成 ⇒ 照提 FORMED（冲突信号；生命周期归 Validator/WP5）
  const activeOther = { ...activeSame, value: 'concise' as const }
  const f6 = await evaluator.process(
    baseInput(formationViews, { activeBelief: activeOther }),
    CTX,
  )
  const formedConflict = f6.proposals.filter((p) => p.targetEvents[0].type === 'BELIEF_FORMED')
  check(
    '异值现存 + 阈值达成 ⇒ 照提 FORMED（冲突是真实信号；DISPUTED/SUPERSEDED 归 WP4/WP5）',
    formedConflict.length === 1,
    `formed=${String(formedConflict.length)}`,
  )

  // 累计状态喂入：2 旧根（跨 2 会话已 1 会话）+ 1 新根新会话 ⇒ 形成
  const accumulation: BeliefEvidenceAccumulation = {
    slotKey,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
    value: 'detailed',
    rootIds: [asConversationEventId('cev:c:dm-1:231'), asConversationEventId('cev:c:dm-1:232')],
    conversationIds: ['dm-1'],
    firstEvidenceAt: NOW,
    lastEvidenceAt: NOW,
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: 'belief-inferred-rules@1',
  }
  const f7 = await evaluator.process(
    baseInput([userView('cev:c:dm-2:233', D_TEXT, 233, 'dm-2')], { accumulation }),
    CTX,
  )
  const formedAccum = f7.proposals.filter((p) => p.targetEvents[0].type === 'BELIEF_FORMED')
  check(
    '跨窗口累计：投影喂入 2 旧根 + 窗口 1 新根（新会话）⇒ 形成（重启不靠无限尾窗）',
    formedAccum.length === 1 &&
      (formedAccum[0].targetEvents[0].payload as { evidenceRootIds: ConversationEventId[] })
        .evidenceRootIds.length === 3,
    `formed=${String(formedAccum.length)} · roots=${String(
      formedAccum.length > 0
        ? (formedAccum[0].targetEvents[0].payload as { evidenceRootIds: ConversationEventId[] })
            .evidenceRootIds.length
        : -1,
    )}`,
  )

  check(
    '冻结阈值常量未被改坏（≥3 根 / ≥2 会话）',
    BELIEF_INFERRED_MIN_ROOTS === 3 && BELIEF_INFERRED_MIN_CONVERSATIONS === 2,
    `roots=${String(BELIEF_INFERRED_MIN_ROOTS)} · conversations=${String(BELIEF_INFERRED_MIN_CONVERSATIONS)}`,
  )

  // =========================================================================
  // §4 afterSequence 增量读（隔离库集成；追加不改旧）
  // =========================================================================
  section('§4 afterSequence 增量读（隔离库）')

  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db: RawDb = kernel.stores.db

  // 追加 5 条 BELIEF_EVIDENCE_NOTED（payload 过结构校验器——顺带证明合同可落库）
  const payloads: BeliefEvidenceNotedPayload[] = []
  for (let i = 0; i < 5; i += 1) {
    const payload: BeliefEvidenceNotedPayload = {
      characterId: kernel.characterId,
      perspectiveOwnerId: asEntityId(String(kernel.characterId)),
      subject: SUBJECT,
      predicate: BELIEF_INFERRED_PREDICATE,
      scopeKey: BELIEF_INFERRED_SCOPE,
      value: 'detailed',
      rootEventId: asConversationEventId(`cev:c:dm-1:${String(301 + i)}`),
      rootSequence: 301 + i,
      conversationId: `dm-${String(1 + (i % 2))}`,
      ruleId: BELIEF_INFERRED_RULE_ID,
      ruleVersion: 'belief-inferred-rules@1',
    }
    validateBeliefEvidenceNotedPayload(payload) // 结构校验器必须接受
    payloads.push(payload)
  }
  for (const [i, payload] of payloads.entries()) {
    await appendDomainEvent(db, kernel.characterId, {
      type: 'BELIEF_EVIDENCE_NOTED',
      operation: 'create',
      payload,
      sourceConversationEventIds: [payload.rootEventId],
      idempotencyKey: `m9-source-verify-evt-${String(i)}`,
      processor: 'm9-source-verify',
      processorVersion: 'm9-source-verify@1',
      scope: 'CHARACTER_INTERNAL',
    })
  }

  const all = await domainEventsFor(db, kernel.characterId, { type: 'BELIEF_EVIDENCE_NOTED' })
  check(
    '基线：不带增量选项的读法与既有语义一致（5 条全量，升序）',
    all.length === 5 && all[0].sequence < all[4].sequence,
    `count=${String(all.length)}`,
  )

  const after2 = await domainEventsFor(db, kernel.characterId, {
    type: 'BELIEF_EVIDENCE_NOTED',
    afterSequence: 2,
  })
  check(
    'afterSequence=2 ⇒ 严格大于（3 条：seq 3/4/5）',
    after2.length === 3 && after2.every((e) => e.sequence > 2),
    `count=${String(after2.length)} · minSeq=${String(after2[0]?.sequence)}`,
  )

  const openInterval = await domainEventsFor(db, kernel.characterId, {
    type: 'BELIEF_EVIDENCE_NOTED',
    afterSequence: 1,
    beforeSequence: 3,
  })
  check(
    '开区间：afterSequence=1 + beforeSequence=3 ⇒ 2 条（seq 2/3）',
    openInterval.length === 2 &&
      openInterval.every((e) => e.sequence > 1 && e.sequence <= 3),
    `count=${String(openInterval.length)}`,
  )

  const afterAll = await domainEventsFor(db, kernel.characterId, {
    type: 'BELIEF_EVIDENCE_NOTED',
    afterSequence: 5,
  })
  check(
    'afterSequence=最大序号 ⇒ 0 条（水位消费的终态：无新事件）',
    afterAll.length === 0,
    `count=${String(afterAll.length)}`,
  )

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  console.log('\n---')
  console.log(`M9 source verify：${String(checks.length)} 项 · 通过 ${String(passed)} · 失败 ${String(failed)}`)

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp3-source', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'source-verify.json'),
    `${JSON.stringify(
      {
        schema: 'm9-wp3-source-verify@1',
        runId,
        head,
        checks,
        summary: { total: checks.length, passed, failed },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeM9Manifest(dir, {
    runId,
    wp: 'wp3',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'source-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['corpus-conformance', 'qualification', 'formation-lifecycle', 'aftersequence-read'],
    supersedes: null,
    notes:
      '语料一致性 20/20+0/20 · 资格四条负控 · 形成生命周期（阈值/强化/冲突/幂等）· afterSequence 增量读（隔离库）',
    mode: 'offline',
    databaseScope: 'isolated',
  })
  console.log(`runId: ${runId}`)

  process.exitCode = failed === 0 ? 0 : 1
}

await main()
