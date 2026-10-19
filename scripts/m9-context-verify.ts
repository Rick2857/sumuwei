/**
 * M9 WP7 门：Context 与开发者读回（计划 §732–742 · ADR-070 §7/§9/§10）。
 *
 * 覆盖：
 *   §0 纯渲染器——冻结基线（逐字节）· 4 条上限 · 原子预算裁剪 · 零预算/零候选 ·
 *      同根去重（reported 限定行 / inferred 不去重）· disputed 原子组 · 相关性 · 确定性
 *   §1 装配 + trace——真网关轮：section 在 packet（id/kind/priority）· belief_context
 *      步的 used_belief_ids 来自**最终 packet** · 开关关 = 逐字节基线 + 无步 ·
 *      构造器在而零候选 = absent · 上下文预算裁掉 = dropped + 空 used
 *   §2 三域矩阵——三 section 并存 · 预算极小时的裁剪顺序（belief 50 先于 affect 52
 *      先于 relationship 55）· INV-M9-05 读侧（affect 内容变化不影响 belief 文本）
 *   §3 开发者面读回——origin/cutover · 信念行与根/依赖 · 事件流 · 双流 job+水位
 *   §4 隐私——trace 属性无命题正文 · section 文本无内部 id
 *
 * 运行：pnpm m9:context:verify（隔离库；不碰真实库）
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'



import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { TurnGateway, type BeliefSectionBuildResult } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  buildBeliefContextSection,
  renderBeliefReadback,
} from '../src/infrastructure/runtime/adapters.ts'
import {
  maybeRunBeliefEvaluation,
  seedBeliefOrigin,
} from '../src/infrastructure/runtime/belief-scheduler.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { SECTION_IDS, buildContextCompilerV2 } from '../src/kernel/context/sections.ts'
import {
  BELIEF_CONTEXT_MAX_ITEMS,
  BELIEF_CONTEXT_TOKEN_BUDGET,
  renderBeliefSection,
  type BeliefContextCandidate,
} from '../src/kernel/contracts/belief-renderer.ts'
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_SCOPE,
  BELIEF_REPORTED_RULE_ID,
  type BeliefState,
} from '../src/kernel/contracts/belief.ts'
import { asCharacterId, asConversationId, entityRef } from '../src/kernel/contracts/index.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function check(id: string, label: string, pass: boolean, actual: string, expected = '见标签'): void {
  checks.push({ id, label, expected, actual, pass })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} :: ${actual}`)
}

// ---------------------------------------------------------------------------
// 夹具：BeliefState 构造（纯渲染器段用）
// ---------------------------------------------------------------------------

let fixtureSeq = 0
/**
 * BeliefState 夹具。参数刻意用宽类型（不标 Partial<BeliefState>）：
 * 品牌类型（BeliefId/ConversationEventId/MemoryId）在纯夹具里没有构造器，
 * contracts 自己的解析层也是 `as ConversationEventId` 直转（belief.ts:810）——
 * 这里沿用同一模式，整体 cast 一次。
 */
function makeBelief(overrides: { beliefId: string } & Record<string, unknown>): BeliefState {
  fixtureSeq += 1
  const base = {
    perspectiveOwnerId: entityRef('character', 'c1'),
    subject: entityRef('user', 'u1'),
    proposition: {
      predicate: BELIEF_INFERRED_PREDICATE,
      value: 'detailed',
      scopeKey: BELIEF_INFERRED_SCOPE,
    },
    epistemicKind: 'inferred',
    status: 'active',
    supportLevel: 'supported',
    evidenceRefs: [],
    evidenceRootIds: [`cev:c1:conv:${String(fixtureSeq)}`],
    dependsOnMemoryIds: [],
    ruleId: 'belief-inferred-rule',
    ruleVersion: 'belief-inferred-rule@1',
  }
  return { ...base, ...overrides } as unknown as BeliefState
}

const QUANTIFIER = (text: string): number => Math.ceil(text.length / 2)
const SUBJECT = { kind: 'user', id: 'u1' }

function candidatesOf(...beliefs: BeliefState[]): BeliefContextCandidate[] {
  return beliefs.map((belief) => ({ belief }))
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main(): Promise<void> {
  // =========================================================================
  // §0 纯渲染器（无 DB；冻结值与原子性的机器判据）
  // =========================================================================
  console.log('\n=== §0 纯渲染器（冻结基线 · 上限 · 原子裁剪 · 去重 · disputed · 相关性） ===')

  const reportedBelief = makeBelief({
    beliefId: 'blf:reported:1',
    proposition: { predicate: 'preference.answer_length', value: 'concise_summary', scopeKey: 'technical' },
    epistemicKind: 'reported',
    evidenceRootIds: ['cev:c1:conv:101'],
    dependsOnMemoryIds: ['mem:c1:1'],
    ruleId: BELIEF_REPORTED_RULE_ID,
  })
  const inferredBelief = makeBelief({
    beliefId: 'blf:inferred:1',
    evidenceRootIds: ['cev:c1:conv:201', 'cev:c1:conv:202', 'cev:c1:conv:203'],
  })

  // c0-01 冻结基线（逐字节；改词形 = 有意改 prompt，须版本化说明）
  {
    const rendered = renderBeliefSection({
      candidates: candidatesOf(reportedBelief, inferredBelief),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
    })
    const expectedText = [
      '【当前可用判断；内部参考，来源强度不等于客观真值】',
      '明确陈述：',
      '· 关于 technical：preference.answer_length 为 concise_summary（用户明确陈述；当前仍有效）',
      '暂定推断：',
      '· 在技术讲解这一范围，对方可能更需要步骤展开（互动推断；暂定，不是用户明确承诺）',
      '限制：这是互动推断与明确陈述的当前采信面；新更正优先；推断不得说成"你说过"；来源强度不等于客观真值。',
    ].join('\n')
    check(
      'c0-01',
      '冻结基线：reported+inferred 双列渲染逐字节一致（§9.2 表达范式）',
      rendered !== undefined && rendered.text === expectedText,
      rendered === undefined ? 'undefined' : `${String(rendered.text === expectedText)}（${String(rendered.itemCount)} 条）`,
      '逐字节一致',
    )
  }

  // c0-02 上限 4 组：6 候选 → 4 入 + 溢出进 dropped
  {
    const six = Array.from({ length: 6 }, (_, i) =>
      makeBelief({
        beliefId: `blf:cap:${String(i)}`,
        proposition: { predicate: `p.slot${String(i)}`, value: `v${String(i)}`, scopeKey: 's' },
        epistemicKind: 'reported',
      }),
    )
    const rendered = renderBeliefSection({
      candidates: candidatesOf(...six),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
    })
    check(
      'c0-02',
      `上限 ${String(BELIEF_CONTEXT_MAX_ITEMS)} 组：6 候选 → 4 入模 + 2 进 dropped（D17）`,
      rendered !== undefined &&
        rendered.usedBeliefIds.length === 4 &&
        rendered.droppedBeliefIds.length === 2 &&
        rendered.itemCount === 4,
      rendered === undefined
        ? 'undefined'
        : `used=${String(rendered.usedBeliefIds.length)} dropped=${String(rendered.droppedBeliefIds.length)}`,
    )
  }

  // c0-03 原子预算：紧预算下条目**整组**进出（无半条）；一条都放不下 → undefined
  {
    const tight = renderBeliefSection({
      candidates: candidatesOf(reportedBelief, inferredBelief),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
      tokenBudget: 60,
    })
    /*
     * 原子性的机器判据不是"几条入选"（那依赖词形长度），而是三条：
     *   ① 每条入选的条目都是**完整**冻结行（命题词形与后缀标签成对出现，
     *      不存在"有命题没标签"的半条）；
     *   ② used ∪ dropped = 全体候选（没有条目无声消失）；
     *   ③ 预算连标题+限制行都放不下 ⇒ undefined（不产半截 section）。
     */
    const completeItems =
      tight === undefined ||
      ((!tight.text.includes('preference.answer_length') ||
        tight.text.includes('（用户明确陈述；当前仍有效）')) &&
        (!tight.text.includes('步骤展开') ||
          tight.text.includes('（互动推断；暂定，不是用户明确承诺）')))
    const noVanish =
      tight !== undefined &&
      new Set([...tight.usedBeliefIds, ...tight.droppedBeliefIds]).size === 2
    const none = renderBeliefSection({
      candidates: candidatesOf(reportedBelief),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
      tokenBudget: 10,
    })
    check(
      'c0-03',
      '原子预算：条目整组进出（无半条）· used∪dropped=全体 · 一条都放不下 ⇒ undefined',
      completeItems && noVanish && none === undefined,
      `完整=${String(completeItems)} 无声消失=${String(noVanish)}（used=${String(tight?.usedBeliefIds.length ?? '-')} dropped=${String(tight?.droppedBeliefIds.length ?? '-')}） none=${none === undefined ? 'undefined' : '有输出'}`,
    )
  }

  // c0-04 零预算 / 零候选 ⇒ undefined（零预算不产 section）
  {
    const zeroBudget = renderBeliefSection({
      candidates: candidatesOf(reportedBelief),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
      tokenBudget: 0,
    })
    const zeroCandidates = renderBeliefSection({
      candidates: [],
      subject: SUBJECT,
      quantifier: QUANTIFIER,
    })
    check(
      'c0-04',
      '零预算 / 零候选 ⇒ 不产 section（§9.1）',
      zeroBudget === undefined && zeroCandidates === undefined,
      `zeroBudget=${zeroBudget === undefined ? 'undefined' : '有输出'} zeroCandidates=${zeroCandidates === undefined ? 'undefined' : '有输出'}`,
    )
  }

  // c0-05 同根去重：reported 全根被记忆覆盖 → 限定行；inferred 同根 → 全条目
  {
    const covered = renderBeliefSection({
      candidates: [
        { belief: reportedBelief, memoryCoveredRootIds: ['cev:c1:conv:101'] },
        { belief: inferredBelief, memoryCoveredRootIds: ['cev:c1:conv:201', 'cev:c1:conv:202', 'cev:c1:conv:203'] },
      ],
      subject: SUBJECT,
      quantifier: QUANTIFIER,
    })
    const reportedQualifierOnly =
      covered !== undefined &&
      covered.text.includes('认知限定（正文见本轮记忆）') &&
      !covered.text.includes('preference.answer_length 为 concise_summary')
    const inferredFull =
      covered !== undefined && covered.text.includes('对方可能更需要步骤展开')
    check(
      'c0-05',
      '同根去重：reported 全根被本轮记忆覆盖 ⇒ 只给认知限定；inferred 不去重（§9.3）',
      reportedQualifierOnly && inferredFull,
      `reported限定行=${String(reportedQualifierOnly)} inferred全条目=${String(inferredFull)}`,
    )
  }

  // c0-06 disputed 原子组：两侧 + 不确定标签 = 1 组
  {
    const disputedOld = makeBelief({
      beliefId: 'blf:disputed:old',
      status: 'disputed',
      proposition: { predicate: BELIEF_INFERRED_PREDICATE, value: 'concise', scopeKey: BELIEF_INFERRED_SCOPE },
    })
    const activeNew = makeBelief({
      beliefId: 'blf:disputed:new',
      proposition: { predicate: BELIEF_INFERRED_PREDICATE, value: 'detailed', scopeKey: BELIEF_INFERRED_SCOPE },
    })
    const rendered = renderBeliefSection({
      candidates: candidatesOf(disputedOld, activeNew),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
    })
    check(
      'c0-06',
      'disputed 原子组：两侧 + 不确定标签同行呈现，算 1 条（§9.1）',
      rendered !== undefined &&
        rendered.itemCount === 1 &&
        rendered.usedBeliefIds.length === 2 &&
        rendered.text.includes('有争议') &&
        rendered.text.includes('不确定'),
      rendered === undefined
        ? 'undefined'
        : `items=${String(rendered.itemCount)} ids=${String(rendered.usedBeliefIds.length)} 含争议=${String(rendered.text.includes('有争议'))}`,
    )
  }

  // c0-07 相关性：subject 不匹配 ⇒ 不入选
  {
    const foreign = renderBeliefSection({
      candidates: candidatesOf(makeBelief({ beliefId: 'blf:foreign:1', subject: entityRef('user', 'someone-else') })),
      subject: SUBJECT,
      quantifier: QUANTIFIER,
    })
    check(
      'c0-07',
      '相关性：subject 不匹配 ⇒ 不产 section（§9.1 "相关后才入选"）',
      foreign === undefined,
      foreign === undefined ? 'undefined' : '有输出',
    )
  }

  // c0-08 确定性：同输入两次 ⇒ 逐字节相同
  {
    const a = renderBeliefSection({ candidates: candidatesOf(reportedBelief, inferredBelief), subject: SUBJECT, quantifier: QUANTIFIER })
    const b = renderBeliefSection({ candidates: candidatesOf(reportedBelief, inferredBelief), subject: SUBJECT, quantifier: QUANTIFIER })
    check(
      'c0-08',
      '确定性：同输入同输出（无挂钟/随机；byte/结构基线的前提）',
      a !== undefined && b !== undefined && a.text === b.text && a.usedBeliefIds.join(',') === b.usedBeliefIds.join(','),
      a !== undefined && b !== undefined ? `text=${String(a.text === b.text)} ids=${String(a.usedBeliefIds.join(',') === b.usedBeliefIds.join(','))}` : 'undefined',
    )
  }

  // =========================================================================
  // 隔离库 + 真装配（§1 起用真网关）
  // =========================================================================
  isolateDatabase('m9-context-verify', { keep: false })
  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const USER = 'm9-wp7-user'
  const CONV_A = asConversationId('m9-wp7-conv-a')
  const CONV_B = asConversationId('m9-wp7-conv-b')
  const T0 = Date.UTC(2026, 8, 27, 6, 0, 0)
  let tickMs = 0
  const tick = (): number => T0 + (tickMs += 500)

  /** 合格用户事件（human-console ingress 举证——资格四条之信封；与 runtime-verify 同形） */
  const userIngress = createHumanConsoleUserTurnIngress()
  const convCounters = new Map<string, number>()
  const qualified = async (text: string, conversationId: typeof CONV_A): Promise<void> => {
    const seq = (convCounters.get(String(conversationId)) ?? 0) + 1
    convCounters.set(String(conversationId), seq)
    await appendConversationEvent(db, {
      characterId,
      conversationId,
      conversationSequence: seq,
      type: 'user_message',
      actorType: 'user',
      actorId: USER,
      content: text,
      createdAt: tick(),
      trustedAttribution: userIngress.attest({
        characterId: String(characterId),
        presenterActorId: USER,
        userId: USER,
      }),
    })
  }

  console.log('\n=== §1 装配 + trace（真网关 · belief_context 来自最终 packet） ===')

  // 前置：建档 + 3 合格根（2 会话）→ FORMED（真调度链）
  await seedBeliefOrigin(db, { characterId, activationId: 'wp7-verify-act-1', now: tick() })
  await qualified('以后都这么讲，每一步都写出来', CONV_A)
  await qualified('以后都这么讲，每一步都写出来', CONV_B)
  await qualified('以后都这么讲，每一步都写出来', CONV_B)
  for (let i = 0; i < 3; i += 1) {
    await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: tick() })
  }
  const formedEvents = await domainEventsFor(db, characterId, { type: 'BELIEF_FORMED' })
  check(
    'c1-01',
    '前置：3 合格根（2 会话）⇒ BELIEF_FORMED 落库（真调度链）',
    formedEvents.length === 1,
    `formed=${String(formedEvents.length)}`,
    'formed=1',
  )

  // 真网关（生产聊天循环的形状）
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId: asConversationId('m9-wp7-gateway-conv'),
    dryRun: false,
    userName: USER,
    characterName: character.name,
    transport: 'm9-wp7-verify',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId: USER,
    userRef: USER,
  })
  let gatewaySeq = 1
  const makeGateway = (tokenBudget?: number) =>
    new TurnGateway({
      kernel,
      definition: kernel.definition,
      identity: kernel.identitySnapshot,
      recorder,
      conversationSequence: () => gatewaySeq,
      recentLimit: 16,
      slowPathEnabled: false,
      dryRun: false,
      userId: USER,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    })
  const gateway = makeGateway()

  /** 真装配的信念构造器（与 main.ts 同一函数） */
  const realBuilder = async (info: { selectedMemoryIds: readonly string[] }): Promise<BeliefSectionBuildResult | undefined> =>
    buildBeliefContextSection(runtime, {
      characterId: String(characterId),
      activeUserId: USER,
      selectedMemoryIds: info.selectedMemoryIds,
    })

  /** 一次网关轮（begin → compile → complete） */
  async function gatewayTurn(
    gw: TurnGateway,
    text: string,
    options: { builder?: typeof realBuilder } = {}
  ): Promise<{ packet: Awaited<ReturnType<TurnGateway['compileTurn']>>; traceId: string }> {
    const turn = await gw.beginTurn(text)
    gatewaySeq = turn.conversationSequence + 2
    const packet = await gw.compileTurn({
      turn,
      currentInput: text,
      recentLines: [],
      clockEpochMs: tick(),
      ...(options.builder !== undefined ? { buildBeliefSection: options.builder } : {}),
    })
    await gw.completeTurn({ turn, replyText: '好的。' })
    return { packet, traceId: String(turn.traceId) }
  }

  // c1-02/03：开关开 → section 在 packet + trace 步的 used 来自最终 packet
  {
    const { packet, traceId } = await gatewayTurn(gateway, '今天天气不错', { builder: realBuilder })
    const section = packet.sections.find((s) => s.id === SECTION_IDS.belief)
    const trace = await getTrace(db, traceId as never)
    const step = (trace?.steps ?? []).find((s) => String(s.kind) === 'belief_context')
    const usedFromStep = step !== undefined ? String(step.attributes.used_belief_ids ?? '') : ''
    const sectionRefs = (section?.sourceRefs ?? []).join(',')
    check(
      'c1-02',
      '开关开：belief section 在最终 packet（id/kind/priority 50 · 文本含冻结标题）',
      section !== undefined &&
        section.kind === 'belief' &&
        section.priority === 50 &&
        section.content.includes('当前可用判断'),
      section === undefined
        ? '无 section'
        : `kind=${section.kind} priority=${String(section.priority)} 标题=${String(section.content.includes('当前可用判断'))}`,
    )
    check(
      'c1-03',
      'belief_context 步：outcome=included · used_belief_ids = 最终 packet 的 sectionRefs（§10.2）',
      step !== undefined &&
        String(step.attributes.outcome) === 'included' &&
        usedFromStep === sectionRefs &&
        usedFromStep.length > 0,
      `outcome=${step !== undefined ? String(step.attributes.outcome) : '无步'} used一致=${String(usedFromStep === sectionRefs)}（${usedFromStep}）`,
    )

    // c4-01 隐私：trace 属性无命题正文（只有 id/计数/结局）
    const attrBlob = step !== undefined ? JSON.stringify(step.attributes) : ''
    const noProposition = !attrBlob.includes('步骤展开') && !attrBlob.includes('preference')
    check(
      'c4-01',
      '隐私：belief_context 属性无命题正文/词形（只有 id/计数/结局标签）',
      noProposition,
      `属性含正文=${String(!noProposition)}`,
    )

    // c4-02 隐私：section 文本无内部 id（cev:/blf:/mem:）
    const text = section?.content ?? ''
    const noIds = !text.includes('cev:') && !text.includes('blf:') && !text.includes('mem:')
    check(
      'c4-02',
      '隐私：section 文本无内部 id（§9.2 不显示数据库 id）',
      noIds,
      `含id=${String(!noIds)}`,
    )
  }

  // c1-04：开关关（不传构造器）⇒ 无 section · 无步（基线机制：trace 不变长）
  {
    const off = await gatewayTurn(gateway, '今天天气不错')
    const offHasSection = off.packet.sections.some((s) => s.id === SECTION_IDS.belief)
    const offTrace = await getTrace(db, off.traceId as never)
    const offHasStep = (offTrace?.steps ?? []).some((s) => String(s.kind) === 'belief_context')
    check(
      'c1-04',
      '开关关：无 belief section · 无 belief_context 步（trace 不变长；基线机制）',
      !offHasSection && !offHasStep,
      `section=${String(offHasSection)} step=${String(offHasStep)}`,
    )
  }

  // c1-05：构造器在而零候选（未建档角色）⇒ absent 步 + 0 section
  {
    const noOriginBuilder = async (): Promise<BeliefSectionBuildResult | undefined> =>
      buildBeliefContextSection(runtime, {
        characterId: '00000000-0000-4000-8000-000000000099',
        activeUserId: USER,
        selectedMemoryIds: [],
      })
    const { packet, traceId } = await gatewayTurn(gateway, '今天天气不错', { builder: noOriginBuilder })
    const trace = await getTrace(db, traceId as never)
    const step = (trace?.steps ?? []).find((s) => String(s.kind) === 'belief_context')
    check(
      'c1-05',
      '构造器在而零候选（未建档）⇒ outcome=absent · 0 section（"开着没内容"≠"关着"）',
      step !== undefined &&
        String(step.attributes.outcome) === 'absent' &&
        !packet.sections.some((s) => s.id === SECTION_IDS.belief),
      `outcome=${step !== undefined ? String(step.attributes.outcome) : '无步'} section=${String(packet.sections.some((s) => s.id === SECTION_IDS.belief))}`,
    )
  }

  // c1-06：上下文预算裁掉 ⇒ outcome=dropped + used_belief_ids 空（§10.2 不许标已使用）
  {
    const tinyGateway = makeGateway(30)
    const { traceId } = await gatewayTurn(tinyGateway, '今天天气不错', { builder: realBuilder })
    const trace = await getTrace(db, traceId as never)
    const step = (trace?.steps ?? []).find((s) => String(s.kind) === 'belief_context')
    check(
      'c1-06',
      '上下文预算裁掉 section ⇒ outcome=dropped · used_belief_ids=空（被裁不许标已使用）',
      step !== undefined &&
        String(step.attributes.outcome) === 'dropped' &&
        String(step.attributes.used_belief_ids ?? '') === '',
      `outcome=${step !== undefined ? String(step.attributes.outcome) : '无步'} used='${step !== undefined ? String(step.attributes.used_belief_ids ?? '') : '-'}'`,
    )
  }

  console.log('\n=== §2 三域矩阵（并存 · 裁剪顺序 · INV-M9-05 读侧独立） ===')

  // c2-01/02/03：stub 三 section（真编译器；矩阵 = 优先级与预算的机器判据）
  {
    const stub = (text: string) => async () => ({ text, sourceRefs: [`stub:${text}`] })
    const compile = async (tokenBudget?: number, affectText = '情绪状态：平静') =>
      buildContextCompilerV2({
        identity: kernel.identitySnapshot,
        definition: kernel.definition,
        renderRelationship: stub('关系：信任度较高'),
        renderAffect: stub(affectText),
        renderBelief: stub('当前可用判断：对方可能更需要步骤展开'),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      }).compile({
        characterId,
        currentInput: '矩阵检查',
        now: tick(),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      })

    const full = await compile()
    const allThree =
      full.sections.some((s) => s.id === SECTION_IDS.relationship) &&
      full.sections.some((s) => s.id === SECTION_IDS.affect) &&
      full.sections.some((s) => s.id === SECTION_IDS.belief)
    check(
      'c2-01',
      '三域并存：relationship/affect/belief 三 section 同时入模（§9.4 矩阵）',
      allThree,
      `在=${String(allThree)}（${full.sections.map((s) => s.id).filter((id) => ['relationship', 'affect', 'belief'].includes(id)).join('+')}）`,
    )

    // 预算极小时的裁剪顺序：droppedSectionIds 是**字母序**（context.ts `.sort()`），
    // 比不出先后——用**存在性扫描**：若 belief(50) 真的先裁，必存在某预算使
    // belief 被裁而 affect 仍留；反之（affect 先裁）那种预算不存在。
    const dropSets: { budget: number; dropped: string[] }[] = []
    // 上限 4000：基座 section（identity/rules/clock/input）本身就过千 token，
    // 三根 stub 一起被裁的预算段远高于 600（第一次实测踩过）。
    for (let budget = 40; budget <= 4000; budget += 5) {
      const packet = await compile(budget)
      dropSets.push({ budget, dropped: [...packet.droppedSectionIds] })
    }
    const beliefDroppedAffectKept = dropSets.find(
      (d) => d.dropped.includes(SECTION_IDS.belief) && !d.dropped.includes(SECTION_IDS.affect)
    )
    const affectDroppedBeliefKept = dropSets.find(
      (d) => d.dropped.includes(SECTION_IDS.affect) && !d.dropped.includes(SECTION_IDS.belief)
    )
    const affectDroppedRelationshipKept = dropSets.find(
      (d) => d.dropped.includes(SECTION_IDS.affect) && !d.dropped.includes(SECTION_IDS.relationship)
    )
    check(
      'c2-02',
      '预算极小：belief(50) 先于 affect(52) 先于 relationship(55) 被裁（存在性扫描）',
      beliefDroppedAffectKept !== undefined &&
        affectDroppedBeliefKept === undefined &&
        affectDroppedRelationshipKept !== undefined,
      `belief先裁@${String(beliefDroppedAffectKept?.budget ?? '-')} · 反例=${String(affectDroppedBeliefKept !== undefined)} · affect先于relationship@${String(affectDroppedRelationshipKept?.budget ?? '-')}`,
    )

    // INV-M9-05 读侧：affect 内容变化不影响 belief section 文本
    const withAffectA = await compile(undefined, '情绪状态：平静')
    const withAffectB = await compile(undefined, '情绪状态：非常低落')
    const beliefTextA = withAffectA.sections.find((s) => s.id === SECTION_IDS.belief)?.content
    const beliefTextB = withAffectB.sections.find((s) => s.id === SECTION_IDS.belief)?.content
    check(
      'c2-03',
      'INV-M9-05 读侧：affect 状态变化不改变 belief section 内容（各读各域）',
      beliefTextA !== undefined && beliefTextA === beliefTextB,
      `一致=${String(beliefTextA === beliefTextB)}`,
    )
  }

  console.log('\n=== §3 开发者面读回（origin/cutover · 信念行 · 事件流 · 双流水位） ===')

  // c3-01：读回七要素
  {
    const readback = await renderBeliefReadback(runtime, String(characterId))
    const covers =
      readback.includes('M9 信念域读回') &&
      readback.includes('cutover') &&
      readback.includes('[active/inferred]') &&
      readback.includes('根 cev:') &&
      readback.includes('BELIEF_') &&
      readback.includes('interaction') &&
      readback.includes('memory')
    check(
      'c3-01',
      '读回覆盖：origin/cutover · 信念行(状态/类别) · 根引用 · 事件流计数 · 双流 job+水位（§10.1）',
      covers,
      `覆盖=${String(covers)}`,
    )
  }

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  console.log('\n---')
  console.log(
    `M9 context verify：${String(checks.length)} 项 · 通过 ${String(passed)} · 失败 ${String(failed)}`,
  )

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp7-context', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'context-verify.json'),
    `${JSON.stringify(
      {
        schema: 'm9-wp7-context-verify@1',
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
    wp: 'wp7',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'verify',
    counts: { total: checks.length, passed, failed },
    phases: ['renderer-pure', 'assembly-trace', 'three-domain-matrix', 'developer-readback', 'privacy'],
    supersedes: null,
    notes:
      '纯渲染器冻结基线（逐字节）· 真网关 belief_context（used 来自最终 packet）· ' +
      '开关关 = 基线机制 · 三域优先级矩阵 · INV-M9-05 读侧 · 读回七要素 · 隐私双查',
    mode: 'offline',
    databaseScope: 'isolated',
  })

  if (failed > 0) process.exitCode = 1
}

await main()
