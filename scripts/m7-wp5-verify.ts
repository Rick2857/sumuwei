/**
 * M7 WP5 —— **上下文接线部件门**（`pnpm m7:wp5:verify`）。
 *
 * ============================================================================
 *  要证明的命题（ADR-064 D-6 / 执行计划 WP5 出口）
 * ============================================================================
 * ① 唯一注入块：关系 section 由 M7 投影确定性渲染（同态同文，逐字节可复现）；
 *    未建档 ⇒ 0 个 section ⇒ prompt 安静（M3.5 基线逐字节不变的机制）。
 * ② 联合行为规则：很亲近但不信 ≠ 又疏远又不信——两维不合并（出口条件）。
 * ③ 措辞纪律：只渲染当前状态与表达方式——全网格扫描**零**共同经历编造词形。
 * ④ 桥接无双权威：开关开 ⇒ legacy 状态块退役关系轴（只剩情绪）；
 *    开关关 ⇒ legacy 形态逐字不变（回滚形态）。
 * ⑤ 装配一致：本门用**与生产同一个** buildContextCompilerV2 / provider 工厂
 *    （import 而非复制）；播种走完整放行链且幂等。
 * ⑥ 读回：投影删行 → rebuild → 渲染逐字节一致（投影是缓存）。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m7-wp5-verify', { keep: false })



import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  renderRelationshipReadback,
  renderRelationshipSection,
  seedRelationshipOrigin,
} from '../src/infrastructure/runtime/adapters.ts'
import { deleteProjection } from '../src/infrastructure/persistence/event-store.ts'
import {
  getRelationshipProjection,
  rebuildRelationshipProjection,
} from '../src/infrastructure/persistence/relationship-store.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import {
  asEntityId,
  effectiveRelationship,
  entityRef,
  renderRelationshipGuidance,
  UNORIGINATED_RELATIONSHIP_STATE,
  type RelationshipState,
} from '../src/kernel/contracts/index.ts'
import { relationshipProjectionType } from '../src/kernel/contracts/relationship.ts'
import {
  buildContextCompilerV2,
  createRelationshipProvider,
  SECTION_IDS,
} from '../src/kernel/context/sections.ts'
import { SECTION_PRIORITY } from '../src/kernel/contracts/index.ts'
import { renderStateBlock } from '../src/state/provider.ts'
import type { CharacterState } from '../src/state/types.ts'
import { baselineIdentity, buildBaselinePrompt } from './m3.5-prompt-baseline.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

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
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9
}

/**
 * 编造共同经历的词形（负控靶；D-6："不叙述事件、不补造共同经历"）。
 *
 * ⚠️ `上次` 只以**复合形**入靶（"上次我们/你/我"）：缺席说明行
 * "距上次互动已过 X 小时"是对锚点时刻的事实陈述（L1-M2 验收过的
 * decayNote 同形措辞），不是编造——裸词会误伤它。
 */
const FABRICATION_MARKERS = [
  '还记得',
  '我们一起',
  '那天',
  '曾经',
  '前两天',
  '上周',
  '上次我们',
  '上次你',
  '上次我',
] as const

function originatedState(overrides: Partial<RelationshipState>): RelationshipState {
  return {
    originated: true,
    trust: 0.85,
    closeness: 0.6,
    originKind: 'SETTING_BASELINE',
    lastInteractionAt: Date.now(),
    accusationsInCase: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const NOW = Date.UTC(2026, 8, 26, 12, 0, 0)
  const DAY_MS = 24 * 60 * 60 * 1000

  // ===========================================================================
  // 正控
  // ===========================================================================

  // P1：确定性 —— 同态同文（逐字节）
  const baselineInput = {
    effective: originatedState({ lastInteractionAt: NOW }),
    now: NOW,
    projection: { revision: 1, updatedAt: NOW },
  }
  const textA = renderRelationshipGuidance(baselineInput)
  const textB = renderRelationshipGuidance(baselineInput)
  record(
    'P1',
    '确定性渲染：同一输入两次调用 ⇒ 逐字节相同',
    'textA === textB（且非空）',
    textA !== undefined && textA === textB ? `逐字节相同（${String(textA?.length)} 字符）` : '不一致或为空',
    textA !== undefined && textA === textB,
  )

  // P2：基线档位 —— {0.85, 0.6} 的语义映射 + 信封行
  // （0.85 ≥ 0.8 档 ⇒ "非常信任"；0.60 ≥ 0.6 档 ⇒ "很亲近"——档位边界如实断言）
  const p2ok =
    textA !== undefined &&
    textA.includes('非常信任对方，几乎不设防') &&
    textA.includes('和对方很亲近') &&
    textA.includes('关系投影 r1')
  record(
    'P2',
    '基线档位：trust 0.85 → 非常信任（≥0.8 档）· closeness 0.60 → 很亲近 · 版本行 r1',
    '三段语义 + 信封行都在',
    p2ok ? '都在' : '缺：' + (textA ?? '').slice(0, 80),
    p2ok,
  )

  // P3：联合行为规则 —— 两维不合并（出口条件）
  const hurtText = renderRelationshipGuidance({
    effective: originatedState({ trust: 0.25, closeness: 0.7 }),
    now: NOW,
    projection: { revision: 2, updatedAt: NOW },
  })
  const coldText = renderRelationshipGuidance({
    effective: originatedState({ trust: 0.25, closeness: 0.2 }),
    now: NOW,
    projection: { revision: 2, updatedAt: NOW },
  })
  const p3ok =
    hurtText !== undefined &&
    coldText !== undefined &&
    hurtText.includes('被辜负') &&
    coldText.includes('客气') &&
    hurtText !== coldText
  record(
    'P3',
    '联合规则：{0.25, 0.7} → 被辜负（受伤起疑）· {0.25, 0.2} → 客气疏远 —— 两态文本不同',
    '亲近不信 ≠ 疏远不信',
    p3ok ? '两态措辞正确且不同' : '联合规则失效',
    p3ok,
  )

  // P4：读时侵蚀 —— 锚点 3 天前 ⇒ 免蚀阈值吃掉 24h，净蚀 2 天 × 0.02：
  //     closeness 0.6 → 0.56（trust 不动）+ 长期分开说明在场
  const eroded = effectiveRelationship(
    originatedState({ closeness: 0.6, lastInteractionAt: NOW - 3 * DAY_MS }),
    NOW
  )
  const erodedText = renderRelationshipGuidance({
    effective: eroded,
    now: NOW,
    projection: { revision: 3, updatedAt: NOW - 3 * DAY_MS },
  })
  const p4ok =
    near(eroded.closeness, 0.56) &&
    near(eroded.trust, 0.85) &&
    erodedText !== undefined &&
    erodedText.includes('长期分开')
  record(
    'P4',
    '读时侵蚀：锚点 3 天前 ⇒ 净蚀 2 天（免蚀阈值 24h）⇒ closeness 0.6→0.56（trust 不动）+ 缺席说明',
    'closeness=0.56 · trust=0.85 · 含长期分开',
    `closeness=${eroded.closeness.toFixed(4)} · trust=${eroded.trust} · 说明=${erodedText?.includes('长期分开') ? '在' : '缺'}`,
    p4ok,
  )

  // P5：provider 形状 —— section 信封（id/kind/priority/droppable）+ 安静机制
  const provider = createRelationshipProvider({
    render: async () => ({ text: textA ?? '', sourceRefs: ['projection:relationship:r1'] }),
  })
  const quietProvider = createRelationshipProvider({ render: async () => undefined })
  const sections = await provider.provide({
    characterId: 'char' as never,
    currentInput: 'x',
    recentEvents: [],
    tokenBudget: 4000,
    now: NOW,
  })
  const quietSections = await quietProvider.provide({
    characterId: 'char' as never,
    currentInput: 'x',
    recentEvents: [],
    tokenBudget: 4000,
    now: NOW,
  })
  const s = sections[0]
  const p5ok =
    sections.length === 1 &&
    quietSections.length === 0 &&
    s !== undefined &&
    s.id === SECTION_IDS.relationship &&
    s.kind === 'relationship' &&
    s.priority === SECTION_PRIORITY.relationship &&
    s.droppable === true
  record(
    'P5',
    'provider 信封：id=relationship · kind=relationship · priority=55 · droppable；render 空 ⇒ 0 个 section',
    '形状正确 + 安静机制成立',
    `sections=${String(sections.length)} · quiet=${String(quietSections.length)} · id=${s?.id} · priority=${String(s?.priority)}`,
    p5ok,
  )

  // ===========================================================================
  // 负控
  // ===========================================================================

  // N1：未建档 ⇒ undefined（安静）
  const unoriginated = renderRelationshipGuidance({
    effective: UNORIGINATED_RELATIONSHIP_STATE,
    now: NOW,
    projection: { revision: 0, updatedAt: 0 },
  })
  record(
    'N1',
    '未建档 ⇒ 渲染 undefined（0 个 section ⇒ prompt 安静）',
    'undefined',
    String(unoriginated),
    unoriginated === undefined,
  )

  // N2：措辞纪律 —— 全网格扫描零编造词形（D-6："不叙述事件、不补造共同经历"）
  const trusts = [0, 0.2, 0.35, 0.6, 0.85, 1]
  const closenesses = [0, 0.2, 0.35, 0.55, 0.8, 1]
  const absences = [0, 2 * DAY_MS, 10 * DAY_MS]
  let renderedVariants = 0
  const violations: string[] = []
  for (const trust of trusts) {
    for (const closeness of closenesses) {
      for (const absence of absences) {
        const effective = effectiveRelationship(
          originatedState({ trust, closeness, lastInteractionAt: NOW - absence }),
          NOW
        )
        const text = renderRelationshipGuidance({
          effective,
          now: NOW,
          projection: { revision: 9, updatedAt: NOW - absence },
        })
        if (text === undefined) continue
        renderedVariants += 1
        for (const marker of FABRICATION_MARKERS) {
          if (text.includes(marker)) violations.push(`trust=${trust}/closeness=${closeness}/abs=${absence}:${marker}`)
        }
      }
    }
  }
  record(
    'N2',
    `措辞纪律：${String(renderedVariants)} 个状态变体全扫描 ⇒ 零编造词形（${FABRICATION_MARKERS.join('/')}）`,
    'violations = 0 且 rendered > 0',
    `rendered=${String(renderedVariants)} · violations=${String(violations.length)}${violations.length > 0 ? `：${violations.slice(0, 3).join('；')}` : ''}`,
    violations.length === 0 && renderedVariants > 0,
  )

  // N3：开关缺省 off + legacy 形态逐字不变（回滚形态）
  const flags = readKernelFlags({})
  const legacyState: CharacterState = {
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
  const legacyBlock = renderStateBlock(legacyState)
  const n3ok =
    flags.relationshipContextEnabled === false &&
    legacyBlock.includes('## 关系') &&
    legacyBlock.includes('trust（信任）')
  record(
    'N3',
    '回滚形态：开关缺省 off；renderStateBlock 缺省含关系轴（M2 验收形态逐字不变）',
    'flag=false · legacy 含 ## 关系',
    `flag=${String(flags.relationshipContextEnabled)} · 含关系轴=${String(legacyBlock.includes('## 关系'))}`,
    n3ok,
  )

  // N4：桥接形态 —— 关系轴退役、情绪保留（无双权威）
  const bridgedBlock = renderStateBlock(legacyState, undefined, { relationshipAxes: false })
  const n4ok =
    !bridgedBlock.includes('## 关系') &&
    !bridgedBlock.includes('trust（信任）') &&
    !bridgedBlock.includes('被辜负') &&
    bridgedBlock.includes('## 情绪') &&
    bridgedBlock.includes('valence')
  record(
    'N4',
    '桥接形态：relationshipAxes=false ⇒ 无关系小节/无 trust 行/无联合规则；情绪小节保留',
    '关系轴退役 · 情绪在场',
    `关系轴=${bridgedBlock.includes('## 关系') ? '仍在（缺陷）' : '已退役'} · 情绪=${bridgedBlock.includes('## 情绪') ? '在' : '缺'}`,
    n4ok,
  )

  // ===========================================================================
  // 隔离库全链路（真存储 + 真装配）
  // ===========================================================================

  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const characterId = kernel.characterId
  const targetUserId = 'm7-wp5-user'

  // P6：播种 → 渲染 → 编译（真链路）
  const seeded = await seedRelationshipOrigin(runtime, String(characterId), targetUserId, NOW)
  const section = await renderRelationshipSection(runtime, String(characterId), targetUserId, NOW)
  const identity = baselineIdentity()
  const compiler = buildContextCompilerV2({
    identity,
    definition: identity.definition,
    recentLimit: 16,
    renderCriticalState: async () => ({
      text: renderStateBlock(legacyState, undefined, { relationshipAxes: false }),
      sourceRefs: ['projection:character-state:v3'],
    }),
    renderRelationship: async () => section ?? undefined,
  })
  const packet = await compiler.compile({
    characterId,
    currentInput: '在吗',
    recentEvents: [],
    now: NOW,
  })
  const relationshipSection = packet.sections.find((x) => x.id === SECTION_IDS.relationship)
  const p6ok =
    seeded.seeded &&
    section !== undefined &&
    relationshipSection !== undefined &&
    relationshipSection.sourceRefs?.includes('projection:relationship:r1') === true
  record(
    'P6',
    '全链路：播种（放行链）→ 读时渲染 → 编译 ⇒ relationship section 在 packet，sourceRefs 带 r1',
    'seeded · section 在场 · 引用 r1',
    `seeded=${String(seeded.seeded)} · section=${relationshipSection !== undefined ? '在' : '缺'} · r1=${String(relationshipSection?.sourceRefs?.includes('projection:relationship:r1'))}`,
    p6ok,
  )

  // P7：播种幂等 —— 二次调用 no-op
  const reseeded = await seedRelationshipOrigin(runtime, String(characterId), targetUserId, NOW)
  record(
    'P7',
    '播种幂等：二次调用 ⇒ seeded=false（投影已存在）',
    'seeded=false',
    `seeded=${String(reseeded.seeded)} · ${reseeded.reason}`,
    reseeded.seeded === false,
  )

  // P8：装配一致 —— 本门与基线构造器用同一个 buildContextCompilerV2；
  //     基线（不传 renderRelationship）不含 relationship section
  const baseline = await buildBaselinePrompt()
  const baselineHasRelationship = baseline.packet.sections.some(
    (x) => x.id === SECTION_IDS.relationship
  )
  record(
    'P8',
    '装配一致：M3.5 基线构造器（同一编译器、不传关系渲染器）⇒ 基线不含 relationship section',
    'baseline 无 relationship（逐字节不变的机制）',
    `baseline sections=[${baseline.packet.sections.map((x) => x.id).join(', ')}]`,
    !baselineHasRelationship,
  )

  // ===========================================================================
  // 恢复
  // ===========================================================================

  // R1：侵蚀后恢复 —— 锚点推进 ⇒ 缺席说明消失、读时值回到投影值
  const longAbsence = renderRelationshipGuidance({
    effective: effectiveRelationship(
      originatedState({ closeness: 0.6, lastInteractionAt: NOW - 10 * DAY_MS }),
      NOW
    ),
    now: NOW,
    projection: { revision: 4, updatedAt: NOW - 10 * DAY_MS },
  })
  const afterReunion = renderRelationshipGuidance({
    effective: effectiveRelationship(
      originatedState({ closeness: 0.42, lastInteractionAt: NOW - 60_000 }),
      NOW
    ),
    now: NOW,
    projection: { revision: 5, updatedAt: NOW },
  })
  const r1ok =
    longAbsence?.includes('长期分开') === true &&
    afterReunion?.includes('长期分开') === false &&
    afterReunion !== undefined
  record(
    'R1',
    '恢复：久别（10 天）有长期分开说明；重逢后（锚点推进）说明消失、读时值回到投影值',
    '久别有说明 · 重逢无说明',
    `久别=${longAbsence?.includes('长期分开') ? '有' : '缺'} · 重逢=${afterReunion?.includes('长期分开') ? '仍有（缺陷）' : '无'}`,
    r1ok,
  )

  // R2：投影是缓存 —— 删行 → rebuild → 渲染逐字节一致 + 读回在场
  const target = entityRef('user', targetUserId)
  const before = await getRelationshipProjection(db2(kernel), characterId, target)
  const sectionBefore = await renderRelationshipSection(runtime, String(characterId), targetUserId, NOW)
  await deleteProjection(db2(kernel), characterId, relationshipProjectionType(target))
  const rebuilt = await rebuildRelationshipProjection(
    db2(kernel),
    characterId,
    entityRef('character', asEntityId(String(characterId))),
    target,
    NOW
  )
  const sectionAfter = await renderRelationshipSection(runtime, String(characterId), targetUserId, NOW)
  const readback = await renderRelationshipReadback(runtime, String(characterId), targetUserId, NOW)
  // ⚠️ 逐值比较（text + sourceRefs），不是对象引用 ===：两次渲染返回两个新对象
  const renderEqual =
    sectionBefore !== undefined &&
    sectionAfter !== undefined &&
    sectionBefore.text === sectionAfter.text &&
    JSON.stringify(sectionBefore.sourceRefs) === JSON.stringify(sectionAfter.sourceRefs)
  const r2ok =
    before !== undefined &&
    rebuilt.projection.revision === before.revision &&
    renderEqual &&
    readback.includes('M7 关系投影')
  record(
    'R2',
    '投影是缓存：删行 → rebuild → 渲染逐字节一致（text+sourceRefs 逐值比较）；--inspect 读回块在场',
    'revision 一致 · 渲染一致 · 读回在场',
    `revision=${String(rebuilt.projection.revision)}（前 ${String(before?.revision)}）· 渲染=${renderEqual ? '一致' : '漂移'} · 读回=${readback.includes('M7 关系投影') ? '在' : '缺'}`,
    r2ok,
  )

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length
  const stagesValid =
    positive > 0 && negative > 0 && recovery > 0 && renderedVariants > 0 && seeded.seeded
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp5-verify', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp5-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    propositions: {
      singleBlock: '关系 section 由 M7 投影确定性渲染；未建档 ⇒ 0 个 section（基线安静）',
      jointRules: '很亲近但不信 ≠ 又疏远又不信（两维不合并）',
      wording: `全网格 ${String(renderedVariants)} 变体零编造词形`,
      bridge: '开关开 ⇒ legacy 退役关系轴；开关关 ⇒ legacy 逐字不变（无双权威）',
      assembly: '与生产同一个编译器/provider 工厂（import 而非复制）；播种走放行链且幂等',
      replay: '删投影 → rebuild → 渲染逐字节一致',
    },
    stages: { positive, negative, recovery },
    measured: { renderedVariants, checks: checks.length },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp5-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'component-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'M7 WP5 部件门：唯一注入块 + 联合规则 + 措辞纪律 + 桥接无双权威 + 装配一致 + rebuild 渲染一致（隔离库）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)} · 渲染变体=${String(renderedVariants)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

/** kernel 句柄 → RawDb（与 adapters 的 getDb 同源：plugin-sql 的 db 包装） */
function db2(kernel: Awaited<ReturnType<typeof initKernel>>) {
  return kernel.stores.db
}

await main()
