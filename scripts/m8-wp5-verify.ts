/**
 * M8 WP5 —— **上下文接线部件门**（`pnpm m8:wp5:verify`）。
 *
 * ============================================================================
 *  要证明的命题（ADR-066 §8.1 / 执行计划 WP5 出口）
 * ============================================================================
 * ① 唯一注入块：affect section 由 M8 投影确定性渲染（同态同文，逐字节可复现）；
 *    未建档 ⇒ 0 个 section ⇒ prompt 安静（M3.5 基线逐字节不变的机制）。
 * ② 措辞纪律：桶位 + 行为行，**零轴名/零数值泄漏**（网格全扫描；
 *    唯一带数字的行是"距上次互动"锚点行——与 M2 decayNote 同形的事实陈述）。
 * ③ 行为行逐字移植：M2 deriveBehaviorGuidance 的情绪子集一字不改
 *    （换一套 = 把 L1-M2 验收过的行为改掉）。
 * ④ 桥接无双权威（M8-D12）：开关开 ⇒ legacy 状态块退役情绪轴
 *    （关系轴归 M7 管，M8 不碰）；开关关 ⇒ legacy 形态逐字不变（回滚形态）。
 * ⑤ 开关缺省 off 且被 main.ts 真的消费（D3 教训的静态锁）。
 * ⑥ 装配一致：本门与生产/M3.5 基线用**同一个** buildContextCompilerV2 /
 *    provider 工厂（import 而非复制）；优先级 52 落在关系 55 与信念 50 之间。
 * ⑦ reply-truth 渲染面：appliedThisTurn=false ⇒ 如实边界行；
 *    true/unknown ⇒ 无边界行（失败不得冒充成功，§6.2）。
 * ⑧ 投影是缓存：删行 → 渲染 undefined（证明读的是投影）→ rebuild → 逐字节一致。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库（本文件顶部），
 * 真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8-wp5-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  renderAffectReadback,
  renderAffectSection,
} from '../src/infrastructure/runtime/adapters.ts'
import { deleteProjection } from '../src/infrastructure/persistence/event-store.ts'
import {
  getAffectProjection,
  rebuildAffectProjection,
} from '../src/infrastructure/persistence/affect-store.ts'
import { seedAffectOrigin } from '../src/infrastructure/runtime/affect-scheduler.ts'
import { readKernelFlags, describeKernelFlags } from '../src/kernel/app/flags.ts'
import {
  effectiveAffect,
  renderAffectGuidance,
  UNORIGINATED_AFFECT_STATE,
  AFFECT_PROJECTION_TYPE,
  type AffectState,
  type AffectEffectiveState,
} from '../src/kernel/contracts/affect.ts'
import {
  buildContextCompilerV2,
  createAffectProvider,
  SECTION_IDS,
} from '../src/kernel/context/sections.ts'
import { SECTION_PRIORITY } from '../src/kernel/contracts/index.ts'
import { renderStateBlock } from '../src/state/provider.ts'
import type { CharacterState } from '../src/state/types.ts'
import { baselineIdentity, buildBaselinePrompt } from './m3.5-prompt-baseline.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

/** 轴名/数值泄漏靶（ADR-066 §8.1：内部数值不进 prompt） */
const AXIS_LEAK_MARKERS = ['valence', 'arousal', '效价', '唤醒'] as const

/** M2 deriveBehaviorGuidance 情绪子集的逐字冻结行（移植正确性的对照源） */
const M2_EMOTION_LINES = {
  veryNegative: '你现在心情很差，回应会明显冷淡、简短，不容易被逗笑。',
  low: '你情绪偏低落，语气比平时更收着。',
  positive: '你心情不错，话会比平时更多。',
  highArousal: '你此刻情绪起伏较大，句子会更碎、更急，容易带上质问或抢话。',
} as const

function originatedState(overrides: Partial<AffectState>): AffectState {
  return {
    originated: true,
    valence: 0,
    arousal: 0,
    originKind: 'ACTIVATION_BASELINE',
    lastInteractionAt: 0,
    lastAffectEventAt: 0,
    lastDomainEventId: 'evt-m8-wp5-origin' as never,
    cutoverSequence: 3,
    ...overrides,
  }
}

function legacyCharacterState(): CharacterState {
  const NOW = Date.UTC(2026, 8, 26, 12, 0, 0)
  return {
    characterId: 'c',
    userId: 'u',
    valence: -0.2,
    arousal: 0.3,
    trust: 0.85,
    closeness: 0.6,
    version: 3,
    lastInteractionAt: NOW,
    updatedAt: NOW,
    createdAt: NOW,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const NOW = Date.UTC(2026, 8, 26, 12, 0, 0)
  const HOUR_MS = 60 * 60 * 1000

  // ===========================================================================
  // 正控（纯契约层，无库）
  // ===========================================================================

  // P1：确定性 —— 同态同文（逐字节）
  const neutralEffective = effectiveAffect(
    originatedState({ lastInteractionAt: NOW, lastAffectEventAt: NOW }),
    NOW
  )
  const textA = renderAffectGuidance({ effective: neutralEffective!, appliedThisTurn: 'unknown' })
  const textB = renderAffectGuidance({ effective: neutralEffective!, appliedThisTurn: 'unknown' })
  record(
    'P1',
    '确定性渲染：同一输入两次调用 ⇒ 逐字节相同（且非空）',
    'textA === textB（且非空）',
    textA === textB && textA.length > 0 ? `逐字节相同（${String(textA.length)} 字符）` : '不一致或为空',
    textA === textB && textA.length > 0,
  )

  // P2：中性档位 —— 0/0 ⇒ 中性 + 平静、情绪低沉；无行为倾向段
  const p2ok =
    textA.includes('# 你此刻的情绪状态') &&
    textA.includes('当前内部状态：中性，平静、情绪低沉。') &&
    !textA.includes('## 此刻的行为倾向')
  record(
    'P2',
    '中性档位：0/0 ⇒ 「中性，平静、情绪低沉」；中性无行为倾向段',
    '标题 + 档位行在场 · 行为倾向段缺席',
    p2ok ? '档位与段形正确' : '缺：' + textA.slice(0, 80),
    p2ok,
  )

  // P3：行为行逐字移植（M2 情绪子集一字不改）
  const moodHigh = renderAffectGuidance({
    effective: effectiveAffect(originatedState({ valence: 0.6, lastInteractionAt: NOW, lastAffectEventAt: NOW }), NOW)!,
    appliedThisTurn: 'unknown',
  })
  const moodLow = renderAffectGuidance({
    effective: effectiveAffect(originatedState({ valence: -0.2, lastInteractionAt: NOW, lastAffectEventAt: NOW }), NOW)!,
    appliedThisTurn: 'unknown',
  })
  const moodVeryLow = renderAffectGuidance({
    effective: effectiveAffect(originatedState({ valence: -0.6, lastInteractionAt: NOW, lastAffectEventAt: NOW }), NOW)!,
    appliedThisTurn: 'unknown',
  })
  const moodAroused = renderAffectGuidance({
    effective: effectiveAffect(originatedState({ arousal: 0.7, lastInteractionAt: NOW, lastAffectEventAt: NOW }), NOW)!,
    appliedThisTurn: 'unknown',
  })
  const p3ok =
    moodHigh.includes(M2_EMOTION_LINES.positive) &&
    moodLow.includes(M2_EMOTION_LINES.low) &&
    moodVeryLow.includes(M2_EMOTION_LINES.veryNegative) &&
    moodAroused.includes(M2_EMOTION_LINES.highArousal)
  record(
    'P3',
    '行为行逐字移植：+0.6→话多 · −0.2→收着 · −0.6→冷淡 · a0.7→碎急（M2 情绪子集一字不改）',
    '四条冻结行全部逐字在场',
    p3ok ? '四行逐字一致' : '存在漂移行',
    p3ok,
  )

  // P4：provider 信封 —— id/kind/priority/droppable + 安静机制
  const provider = createAffectProvider({
    render: async () => ({ text: textA, sourceRefs: ['projection:affect:r1'] }),
  })
  const quietProvider = createAffectProvider({ render: async () => undefined })
  const compileInput = {
    characterId: 'char' as never,
    currentInput: 'x',
    recentEvents: [],
    tokenBudget: 4000,
    now: NOW,
  }
  const sections = await provider.provide(compileInput)
  const quietSections = await quietProvider.provide(compileInput)
  const s = sections[0]
  const p4ok =
    sections.length === 1 &&
    quietSections.length === 0 &&
    s !== undefined &&
    s.id === SECTION_IDS.affect &&
    s.kind === 'affect' &&
    s.priority === SECTION_PRIORITY.affect &&
    s.priority === 52 &&
    s.droppable === true
  record(
    'P4',
    'provider 信封：id=affect · kind=affect · priority=52 · droppable；render 空 ⇒ 0 个 section',
    '形状正确 + 安静机制成立',
    `sections=${String(sections.length)} · quiet=${String(quietSections.length)} · id=${s?.id} · priority=${String(s?.priority)}`,
    p4ok,
  )

  // P5：开关 —— 缺省 off · env 打开 · 摘要可见 · main.ts 真消费（静态锁）
  const flagsOff = readKernelFlags({})
  const flagsOn = readKernelFlags({ CHARACTER_AFFECT_CONTEXT_ENABLED: 'true' })
  const mainSource = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
  const consumptionCount = mainSource.split('affectContextEnabled').length - 1
  const p5ok =
    flagsOff.affectContextEnabled === false &&
    flagsOn.affectContextEnabled === true &&
    describeKernelFlags(flagsOff).includes('affect-context=off') &&
    consumptionCount >= 4
  record(
    'P5',
    `开关：缺省 off · env 可开 · 摘要含 affect-context= · main.ts 真消费（静态锁，实测 ${String(consumptionCount)} 处 ≥ 4）`,
    'false / true / 摘要在场 / 消费 ≥ 4 处',
    `off=${String(flagsOff.affectContextEnabled)} · on=${String(flagsOn.affectContextEnabled)} · 消费=${String(consumptionCount)} 处`,
    p5ok,
  )

  // ===========================================================================
  // 负控（纯契约层）
  // ===========================================================================

  // N1：措辞纪律 —— 全网格扫描零轴名泄漏；除锚点行外零数字
  const valences = [-0.8, -0.3, 0, 0.3, 0.8]
  const arousals = [0.1, 0.5, 0.8]
  const absences = [0, 2 * HOUR_MS, 30 * HOUR_MS]
  let renderedVariants = 0
  const violations: string[] = []
  for (const valence of valences) {
    for (const arousal of arousals) {
      for (const absence of absences) {
        const effective = effectiveAffect(
          originatedState({
            valence,
            arousal,
            lastInteractionAt: NOW - absence,
            lastAffectEventAt: NOW - absence,
          }),
          NOW
        )
        if (effective === undefined) continue
        const text = renderAffectGuidance({ effective, appliedThisTurn: 'unknown' })
        renderedVariants += 1
        for (const marker of AXIS_LEAK_MARKERS) {
          if (text.includes(marker)) violations.push(`v=${valence}/a=${arousal}/abs=${absence}:轴名 ${marker}`)
        }
        // 数字纪律：剥掉锚点行（距上次互动——M2 decayNote 同形的事实陈述）后不许有数字
        const stripped = text
          .split('\n')
          .filter((line) => !line.startsWith('（距上次互动'))
          .join('\n')
        if (/\d/.test(stripped)) violations.push(`v=${valence}/a=${arousal}/abs=${absence}:数字泄漏`)
      }
    }
  }
  record(
    'N1',
    `措辞纪律：${String(renderedVariants)} 个状态变体全扫描 ⇒ 零轴名（valence/arousal/效价/唤醒）· 除锚点行外零数字`,
    'violations = 0 且 rendered > 0',
    `rendered=${String(renderedVariants)} · violations=${String(violations.length)}${violations.length > 0 ? `：${violations.slice(0, 3).join('；')}` : ''}`,
    violations.length === 0 && renderedVariants > 0,
  )

  // N2：回滚形态 —— 缺省（两轴都开）与 M2 验收形态一致
  const legacyBlock = renderStateBlock(legacyCharacterState())
  const n2ok =
    legacyBlock.includes('## 情绪') &&
    legacyBlock.includes('valence（情绪效价）') &&
    legacyBlock.includes('arousal（情绪唤醒）') &&
    legacyBlock.includes('## 关系')
  record(
    'N2',
    '回滚形态：renderStateBlock 缺省含情绪轴 + 关系轴（M2 验收形态逐字不变——开关关闭时的形态）',
    '## 情绪 · valence 行 · arousal 行 · ## 关系 全在场',
    `情绪=${legacyBlock.includes('## 情绪') ? '在' : '缺'} · 关系=${legacyBlock.includes('## 关系') ? '在' : '缺'}`,
    n2ok,
  )

  // N3：桥接形态 —— affectAxes=false ⇒ 情绪轴退役；关系轴不受 M8 影响（M8-D10/D12）
  const bridgedBlock = renderStateBlock(legacyCharacterState(), undefined, { affectAxes: false })
  const n3ok =
    !bridgedBlock.includes('## 情绪') &&
    !bridgedBlock.includes('valence') &&
    !bridgedBlock.includes('arousal') &&
    !bridgedBlock.includes(M2_EMOTION_LINES.low) &&
    bridgedBlock.includes('## 关系') &&
    bridgedBlock.includes('trust（信任）')
  record(
    'N3',
    '桥接形态：affectAxes=false ⇒ 情绪小节/轴行/情绪行为行退役；关系轴原样（M8 不碰 M7 的轴）',
    '情绪轴退役 · 关系轴在场',
    `情绪=${bridgedBlock.includes('## 情绪') ? '仍在（缺陷）' : '已退役'} · 关系=${bridgedBlock.includes('## 关系') ? '在' : '缺'}`,
    n3ok,
  )

  // N4：双桥接 —— 两开关都开 ⇒ legacy 两轴全退役（无双权威的完整形态）
  const doubleBridged = renderStateBlock(legacyCharacterState(), undefined, {
    relationshipAxes: false,
    affectAxes: false,
  })
  const n4ok =
    !doubleBridged.includes('## 情绪') &&
    !doubleBridged.includes('## 关系') &&
    !doubleBridged.includes('valence') &&
    !doubleBridged.includes('trust')
  record(
    'N4',
    '双桥接：relationshipAxes=false 且 affectAxes=false ⇒ legacy 两轴全退役（语义由两个注入块唯一承载）',
    '两轴小节全部缺席',
    `情绪=${doubleBridged.includes('## 情绪') ? '仍在（缺陷）' : '退役'} · 关系=${doubleBridged.includes('## 关系') ? '仍在（缺陷）' : '退役'}`,
    n4ok,
  )

  // ===========================================================================
  // 隔离库全链路（真存储 + 真装配）
  // ===========================================================================

  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const characterId = kernel.characterId
  const db = kernel.stores.db

  // N5：未建档 ⇒ 渲染 undefined（安静）+ 读回如实说明
  const unseededSection = await renderAffectSection(runtime, String(characterId), NOW)
  const unseededReadback = await renderAffectReadback(runtime, String(characterId), NOW)
  record(
    'N5',
    '未建档 ⇒ renderAffectSection = undefined（0 个 section ⇒ prompt 安静）；--inspect 读回如实说未建档',
    'undefined · 读回含未建档',
    `section=${String(unseededSection)} · 读回=${unseededReadback.includes('未建档') ? '如实' : '失实'}`,
    unseededSection === undefined && unseededReadback.includes('未建档'),
  )

  // P6：播种 → 渲染 → 编译（真链路；优先级 52 落在关系 55 之后）
  const seeded = await seedAffectOrigin(db, {
    characterId,
    activationId: 'm8-wp5-verify',
    now: NOW,
  })
  const section = await renderAffectSection(runtime, String(characterId), NOW)
  const identity = baselineIdentity()
  const compiler = buildContextCompilerV2({
    identity,
    definition: identity.definition,
    recentLimit: 16,
    renderCriticalState: async () => ({
      text: renderStateBlock(legacyCharacterState(), undefined, { affectAxes: false }),
      sourceRefs: ['projection:character-state:v3'],
    }),
    // 关系块用同形 stub（排序性质只看优先级，不看关系数据——那是 M7 的门）
    renderRelationship: async () => ({
      text: '# 你们此刻的关系\n\n（M7 注入块占位）',
      sourceRefs: ['projection:relationship:r1'],
    }),
    renderAffect: async () => section ?? undefined,
  })
  const packet = await compiler.compile({
    characterId,
    currentInput: '在吗',
    recentEvents: [],
    now: NOW,
  })
  const affectInPacket = packet.sections.find((x) => x.id === SECTION_IDS.affect)
  const relationshipIdx = packet.sections.findIndex((x) => x.id === SECTION_IDS.relationship)
  const affectIdx = packet.sections.findIndex((x) => x.id === SECTION_IDS.affect)
  const p6ok =
    seeded.kind === 'seeded' &&
    section !== undefined &&
    affectInPacket !== undefined &&
    affectInPacket.sourceRefs?.includes('projection:affect:r1') === true &&
    relationshipIdx >= 0 &&
    affectIdx > relationshipIdx
  record(
    'P6',
    '全链路：播种（放行链）→ 读时渲染 → 编译 ⇒ affect section 在 packet（sourceRefs 带 r1）且排在 relationship(55) 之后',
    'seeded · section 在场 · 引用 r1 · 55 在 52 前',
    `seeded=${seeded.kind} · section=${affectInPacket !== undefined ? '在' : '缺'} · relIdx=${String(relationshipIdx)} < affectIdx=${String(affectIdx)}`,
    p6ok,
  )

  // P7：播种幂等 —— 二次调用 already
  const reseeded = await seedAffectOrigin(db, {
    characterId,
    activationId: 'm8-wp5-verify',
    now: NOW,
  })
  record(
    'P7',
    '播种幂等：二次调用 ⇒ already（不产生第二个 ORIGIN）',
    'kind=already',
    `kind=${reseeded.kind}${reseeded.kind === 'already' ? `（${reseeded.reason}）` : ''}`,
    reseeded.kind === 'already',
  )

  // P8：装配一致 —— M3.5 基线构造器（同一编译器、不传 affect 渲染器）⇒ 基线不含 affect section
  const baseline = await buildBaselinePrompt()
  const baselineHasAffect = baseline.packet.sections.some((x) => x.id === SECTION_IDS.affect)
  record(
    'P8',
    '装配一致：M3.5 基线构造器（同一编译器、不传 affect 渲染器）⇒ 基线不含 affect section（逐字节不变的机制）',
    'baseline 无 affect',
    `baseline sections=[${baseline.packet.sections.map((x) => x.id).join(', ')}]`,
    !baselineHasAffect,
  )

  // P9：reply-truth 渲染面 —— appliedThisTurn=false ⇒ 边界行；true/unknown ⇒ 无
  const failedRender = renderAffectGuidance({ effective: neutralEffective!, appliedThisTurn: false })
  const okRender = renderAffectGuidance({ effective: neutralEffective!, appliedThisTurn: true })
  const BOUNDARY = '（本轮情绪处理未完成——以上是上一份有效状态，不要声称你的情绪因对方刚才的话而改变。）'
  const p9ok =
    failedRender.includes(BOUNDARY) &&
    !okRender.includes(BOUNDARY) &&
    !textA.includes(BOUNDARY)
  record(
    'P9',
    'reply-truth 渲染面：appliedThisTurn=false ⇒ 如实边界行；true/unknown ⇒ 无边界行（§6.2 失败不得冒充成功）',
    'false 有边界 · true/unknown 无边界',
    `false=${failedRender.includes(BOUNDARY) ? '有' : '缺'} · true=${okRender.includes(BOUNDARY) ? '有（缺陷）' : '无'} · unknown=${textA.includes(BOUNDARY) ? '有（缺陷）' : '无'}`,
    p9ok,
  )

  // ===========================================================================
  // 恢复
  // ===========================================================================

  // R1：投影是缓存 —— 删行 ⇒ 渲染 undefined（证明读投影）→ rebuild → 逐字节一致
  const sectionBefore = await renderAffectSection(runtime, String(characterId), NOW)
  await deleteProjection(db, characterId, AFFECT_PROJECTION_TYPE)
  const sectionWhileDeleted = await renderAffectSection(runtime, String(characterId), NOW)
  const rebuilt = await rebuildAffectProjection(db, characterId, NOW)
  const sectionAfter = await renderAffectSection(runtime, String(characterId), NOW)
  const renderEqual =
    sectionBefore !== undefined &&
    sectionAfter !== undefined &&
    sectionBefore.text === sectionAfter.text &&
    JSON.stringify(sectionBefore.sourceRefs) === JSON.stringify(sectionAfter.sourceRefs)
  const r1ok =
    sectionBefore !== undefined &&
    sectionWhileDeleted === undefined &&
    rebuilt.appliedEvents > 0 &&
    renderEqual
  record(
    'R1',
    '投影是缓存：删行 ⇒ 渲染 undefined（读的是投影不是缓存值）→ rebuild（事务）→ 渲染逐字节一致',
    '删后 undefined · rebuild applied>0 · 渲染一致',
    `删后=${sectionWhileDeleted === undefined ? 'undefined' : '仍有（缺陷）'} · applied=${String(rebuilt.appliedEvents)} · 渲染=${renderEqual ? '一致' : '漂移'}`,
    r1ok,
  )

  // R2：读回三段式 —— canonical（轴值/cutover）+ effective（读时视图）+ legacy 对照行
  const readback = await renderAffectReadback(runtime, String(characterId), NOW)
  const r2ok =
    readback.includes('M8 情绪投影') &&
    readback.includes('cutover') &&
    readback.includes('Valence') &&
    readback.includes('读时视图') &&
    readback.includes('legacy')
  record(
    'R2',
    '读回三段式：--inspect 块含 canonical（轴值/cutover）+ 读时视图 + legacy 退役对照',
    '三段全在场',
    `canonical=${readback.includes('Valence') ? '在' : '缺'} · effective=${readback.includes('读时视图') ? '在' : '缺'} · legacy=${readback.includes('legacy') ? '在' : '缺'}`,
    r2ok,
  )

  // R3：负控之后恢复 —— 全链路重走一遍仍干净（播种幂等 + 渲染 + 编译 + 无边界行）
  const reseed = await seedAffectOrigin(db, {
    characterId,
    activationId: 'm8-wp5-verify',
    now: NOW,
  })
  const recoverySection = await renderAffectSection(runtime, String(characterId), NOW, true)
  const projection = await getAffectProjection(db, characterId)
  const r3ok =
    reseed.kind === 'already' &&
    recoverySection !== undefined &&
    !recoverySection.text.includes(BOUNDARY) &&
    projection !== undefined &&
    projection.state.originated &&
    projection.state.cutoverSequence !== null
  record(
    'R3',
    '恢复：负控/删行之后全链路重走 ⇒ 播种幂等（already）· 渲染在场 · appliedThisTurn=true 无边界行 · 投影 cutover 完整',
    'already · section 在 · 无边界 · cutover 非 null',
    `seed=${reseed.kind} · section=${recoverySection !== undefined ? '在' : '缺'} · 边界=${recoverySection?.text.includes(BOUNDARY) ? '有（缺陷）' : '无'} · cutover=${String(projection?.state.cutoverSequence)}`,
    r3ok,
  )

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length
  const seededOk = seeded.kind === 'seeded'
  const stagesValid =
    positive > 0 && negative > 0 && recovery > 0 && renderedVariants > 0 && seededOk
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const argOf = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const supersedes = argOf('--supersedes') ?? null
  const supersedesReason = argOf('--supersedes-reason')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM8RunId({ wpId: 'wp5-verify', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-wp5-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    propositions: {
      singleBlock: 'affect section 由 M8 投影确定性渲染；未建档 ⇒ 0 个 section（基线安静）',
      wording: `全网格 ${String(renderedVariants)} 变体零轴名泄漏、除锚点行外零数字`,
      transplant: '行为行与 M2 deriveBehaviorGuidance 情绪子集逐字一致',
      bridge: '开关开 ⇒ legacy 退役情绪轴（关系轴归 M7，M8 不碰）；开关关 ⇒ legacy 逐字不变',
      flag: '缺省 off · env 可开 · 摘要可见 · main.ts 真消费（静态锁）',
      assembly: '与生产/基线同一编译器与 provider 工厂（import 而非复制）；52 落在 55 与 50 之间',
      replyTruth: 'appliedThisTurn=false ⇒ 如实边界行；true/unknown ⇒ 无',
      replay: '删行 ⇒ undefined → rebuild → 渲染逐字节一致（投影是缓存）',
    },
    stages: { positive, negative, recovery },
    measured: { renderedVariants, checks: checks.length },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'context-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
    runId,
    wp: 'wp5-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'context-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP5 上下文接线门（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : 'M8 WP5 上下文接线门：唯一注入块 + 措辞纪律 + 桥接无双权威 + 静态锁 + rebuild 渲染一致（隔离库）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)} · 渲染变体=${String(renderedVariants)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
