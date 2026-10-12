/**
 * M11 WP8 —— **上下文注入与回复事实门**（`m11:context:verify`）。
 *
 * ============================================================================
 *  本门要测的命题
 * ============================================================================
 * ```text
 * ① **额度 0 ⇒ 0 个 section**（连候选都不看）—— 关闭档的 prompt 与基线一致靠这个。
 * ② **只有 enhanced 进上下文**；至多三条；正文**只**来自程序模板（不含内部 id）。
 * ③ **被裁 ≠ 入模**：`adaptiveSelfContextReality()` 在 section 没活下来时**清空** selectedRefs。
 * ④ **`D34` 真接线**：`src/main.ts` 里**真的**出现 `adaptiveSelfTokens`（静态回归锁）。
 * ⑤ **六态事实包**：每个状态的禁止项都含那条最要紧的夸大（待审不能说已养成习惯…）。
 * ⑥ **不碰别的域**：跑完这些之后 Memory / Belief / Goal 的事件数不变。
 * ```
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

isolateDatabase('m11-context-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import { DEFAULT_CONTEXT_BUDGET, assertContextBudget } from '../src/kernel/recall/selector.ts'
import {
  ADAPTIVE_SELF_BLOCK_HEADER,
  ADAPTIVE_SELF_BOUNDARY_HEADER,
  ADAPTIVE_SELF_SECTION_ID,
  adaptiveSelfContextReality,
  adaptiveSelfRefOf,
  createAdaptiveSelfProvider,
  renderAdaptiveSelfSection,
} from '../src/kernel/context/adaptive-self-sections.ts'
import { OBSERVABILITY_STAGES } from '../src/kernel/contracts/observability.ts'
import {
  ADAPTIVE_SELF_BOUNDARY_FACTS,
  ADAPTIVE_SELF_OUT_OF_SCOPE_AXES,
  ADAPTIVE_SELF_SLOTS,
  ADAPTIVE_SELF_TEMPLATES,
  baselineAdaptiveSelfState,
  renderAdaptiveSelfLine,
  type AdaptiveSelfState,
} from '../src/kernel/contracts/adaptive-self.ts'
import { SECTION_PRIORITY } from '../src/kernel/contracts/context.ts'
import {
  REFLECTION_FACT_STATES,
  buildReflectionFactPack,
  reflectionFactInputFrom,
  reflectionFactStateOf,
  type ReflectionFactInput,
  type ReflectionFactState,
} from '../src/kernel/app/reflection/fact-pack.ts'
import { reflectionContentMustBeMasked } from '../src/kernel/app/reflection/masking.ts'
import type { ReflectionRecordState } from '../src/kernel/contracts/reflection-events.ts'
import {
  DEVELOPER_REFLECTION_CAPABILITY_FACTS,
  DEVELOPER_REFLECTION_FORBIDDEN_EXPORT_PATTERNS,
  buildDeveloperReflectionList,
} from '../src/kernel/app/reflection/developer-face.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

const quantify = (text: string): number => text.length

const enhanced = (slot: (typeof ADAPTIVE_SELF_SLOTS)[number], revision: number): AdaptiveSelfState => ({
  ...baselineAdaptiveSelfState(slot),
  level: 'enhanced',
  revision,
  roots: ['ce:1', 'ce:2', 'ce:3'],
  changedReason: 'threshold_met_with_three_independent_roots',
})

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-context-verify' })
  const db = h.db
  const characterId = h.kernel.characterId

  const states: AdaptiveSelfState[] = [
    enhanced('clarify_when_ambiguous', 1),
    baselineAdaptiveSelfState('acknowledge_correction_first'),
    enhanced('recheck_goal_before_next_step', 2),
  ]

  // -------------------------------------------------------------------------
  // A 组 —— 额度 0 ⇒ 0 个 section（`D20`）
  // -------------------------------------------------------------------------
  const zero = renderAdaptiveSelfSection({ states, maxTokens: 0, quantify })
  record(
    'A1',
    'A',
    '【关闭档】额度 0 ⇒ **0 个 section**（`D20`：连候选都不看）',
    zero.length === 0,
    `sections=${String(zero.length)}`
  )
  record(
    'A2',
    'A',
    '`ContextBudget.adaptiveSelfTokens` 的**代码缺省 = 0**（与 `externalEvidenceTokens` / `rollupTokens` / `goalTokens` 同构）',
    DEFAULT_CONTEXT_BUDGET.adaptiveSelfTokens === 0,
    `缺省=${String(DEFAULT_CONTEXT_BUDGET.adaptiveSelfTokens)}`
  )
  record(
    'A3',
    'A',
    '额度进入**失败关闭**的预算校验（负数 / 非整数都被拦）',
    (() => {
      try {
        assertContextBudget({ ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: -1 })
        return false
      } catch {
        return true
      }
    })() &&
      (() => {
        try {
          assertContextBudget({ ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: 1.5 })
          return false
        } catch {
          return true
        }
      })(),
    '负数与非整数都抛 `recall_bad_budget`'
  )
  const overcommit = (() => {
    try {
      assertContextBudget({ ...DEFAULT_CONTEXT_BUDGET, memoryTokens: 6000, adaptiveSelfTokens: 800 })
      return false
    } catch {
      return true
    }
  })()
  record(
    'A4',
    'A',
    '超额配置在**装配时**失败（新额度也计入 committed 求和）',
    overcommit,
    '记忆 6000 + 预留 2400 + … > 总预算 ⇒ 抛 `recall_budget_overcommitted`'
  )

  // -------------------------------------------------------------------------
  // B 组 —— 渲染（只有 enhanced / 至多三条 / 正文只来自模板）
  // -------------------------------------------------------------------------
  const rendered = renderAdaptiveSelfSection({ states, maxTokens: 300, quantify })
  const section = rendered[0]
  record(
    'B1',
    'B',
    '【正控】额度 > 0 且有 enhanced 槽 ⇒ 1 个 section：kind / 优先级 / 可裁 都对',
    rendered.length === 1 &&
      section?.kind === 'adaptive-self' &&
      section?.priority === SECTION_PRIORITY.adaptiveSelf &&
      section?.droppable === true &&
      section?.id === ADAPTIVE_SELF_SECTION_ID,
    `kind=${String(section?.kind)} · priority=${String(section?.priority)} · droppable=${String(section?.droppable)}`
  )
  record(
    'B2',
    'B',
    '**只有 enhanced 进上下文**：baseline 的槽不出现（否则等于凭空多出一段指令）',
    section !== undefined &&
      section.content.includes(ADAPTIVE_SELF_TEMPLATES.clarify_when_ambiguous) &&
      !section.content.includes(ADAPTIVE_SELF_TEMPLATES.acknowledge_correction_first),
    `正文行数=${String(section?.content.split('\n').filter((line) => line.startsWith('- ')).length)}`
  )
  record(
    'B3',
    'B',
    '**至多三条**（`D27`）：三槽全 enhanced 时也只有三条**槽位行**' +
      '（⚠️ 事实段是**固定前缀**、不计入这三条 —— 判据跟着块形状改）',
    (() => {
      const all = ADAPTIVE_SELF_SLOTS.map((slot, index) => enhanced(slot, index + 1))
      const full = renderAdaptiveSelfSection({ states: all, maxTokens: 400, quantify })[0]
      /*
       * ⚠️ **只数槽位行**：第一版按 `- ` 前缀数行 ⇒ 把新增的**事实行**也数进去 ⇒ B3 假红。
       *    槽位行的判定方式：它等于某个槽的模板渲染。
       */
      const content = full?.content ?? ''
      const slotLines = ADAPTIVE_SELF_SLOTS.filter((slot) =>
        content.includes(`- ${renderAdaptiveSelfLine(slot)}`)
      )
      return slotLines.length === 3
    })(),
    (() => {
      const all = ADAPTIVE_SELF_SLOTS.map((slot, index) => enhanced(slot, index + 1))
      const full = renderAdaptiveSelfSection({ states: all, maxTokens: 400, quantify })[0]
      const content = full?.content ?? ''
      return `槽位行=${String(ADAPTIVE_SELF_SLOTS.filter((slot) => content.includes(`- ${renderAdaptiveSelfLine(slot)}`)).length)} · 总行=${String(content.split('\n').filter((line) => line.startsWith('- ')).length)}（含事实行）`
    })()
  )
  record(
    'B4',
    'B',
    '**正文只来自程序模板**：正文里没有内部 id / revision（它们只进 `sourceRefs`）',
    section !== undefined &&
      !section.content.includes('@') &&
      !section.content.includes('ce:1') &&
      (section.sourceRefs ?? []).every((ref) => ref.startsWith('adaptive-self:')) &&
      (section.sourceRefs ?? []).length === 2,
    `sourceRefs=${JSON.stringify(section?.sourceRefs)} · 正文含@=${String(section?.content.includes('@'))}`
  )
  record(
    'B5',
    'B',
    '`sourceRefs` 逐条带**槽位与 revision**（trace 据此逐 id/revision 对账）',
    (section?.sourceRefs ?? []).includes(adaptiveSelfRefOf(states[0]!)) &&
      (section?.sourceRefs ?? []).includes(adaptiveSelfRefOf(states[2]!)),
    `期望含 ${adaptiveSelfRefOf(states[0]!)} / ${adaptiveSelfRefOf(states[2]!)}`
  )
  /*
   * ⚠️ 紧额度必须**带上事实前缀**（块形状改了：事实段是固定前缀，优先于槽位行）——
   *    第一版只算"头 + 一条槽位行"，于是连事实都放不下 ⇒ 整块返回 [] ⇒ B6 假红。
   */
  const factsPrefix = [
    ADAPTIVE_SELF_BOUNDARY_HEADER,
    ...ADAPTIVE_SELF_BOUNDARY_FACTS.map((fact) => `- ${fact}`),
  ].join('\n')
  const tight = renderAdaptiveSelfSection({
    states,
    maxTokens:
      quantify(`${ADAPTIVE_SELF_BLOCK_HEADER}\n${factsPrefix}\n- ${ADAPTIVE_SELF_TEMPLATES.clarify_when_ambiguous}\n`) + 1,
    quantify,
  })[0]
  record(
    'B6',
    'B',
    '额度只够一条时：只渲染一条（**不**改写成"更短的正确版"）',
    (tight?.sourceRefs ?? []).length === 1,
    `sourceRefs=${JSON.stringify(tight?.sourceRefs)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 被裁 ≠ 入模 + `D34` 真接线
  // -------------------------------------------------------------------------
  const intended = ['adaptive-self:clarify_when_ambiguous@1']
  const dropped = adaptiveSelfContextReality({ intendedRefs: intended, sectionSurvived: false })
  const kept = adaptiveSelfContextReality({ intendedRefs: intended, sectionSurvived: true })
  record(
    'C1',
    'C',
    '【被裁 ≠ 入模】section 没活下来 ⇒ `selectedRefs` **清空**、`reachedContext=false`、`droppedByContextBudget=true`',
    dropped.selectedRefs.length === 0 &&
      dropped.reachedContext === false &&
      dropped.droppedByContextBudget === true &&
      dropped.intendedRefs.length === 1,
    `selected=${JSON.stringify(dropped.selectedRefs)} · reached=${String(dropped.reachedContext)} · dropped=${String(dropped.droppedByContextBudget)}`
  )
  record(
    'C2',
    'C',
    '【入模】section 活下来 ⇒ `selectedRefs` 等于最终 packet 里的引用（逐 id/revision）',
    kept.reachedContext === true &&
      kept.selectedRefs.join(',') === intended.join(',') &&
      kept.droppedByContextBudget === false,
    `selected=${JSON.stringify(kept.selectedRefs)}`
  )

  const mainSrc = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
  const mainStripped = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  record(
    'C3',
    'C',
    '【`D34` 真接线】`src/main.ts` 里**真的**出现 `adaptiveSelfTokens`（静态回归锁；先例 `L-M11-10`）',
    mainStripped.includes('adaptiveSelfTokens'),
    `命中=${String(mainStripped.includes('adaptiveSelfTokens'))}`
  )
  const flagsSrc = readFileSync(join(REPO_ROOT, 'src/kernel/app/flags.ts'), 'utf8')
  record(
    'C4',
    'C',
    '两个开关名与缺省都在（`CHARACTER_REFLECTION_ENABLED` / `CHARACTER_ADAPTIVE_SELF_ENABLED`，代码缺省 **false**）',
    flagsSrc.includes('CHARACTER_REFLECTION_ENABLED') &&
      flagsSrc.includes('CHARACTER_ADAPTIVE_SELF_ENABLED') &&
      /reflectionEnabled: truthy\(env\.CHARACTER_REFLECTION_ENABLED, false\)/.test(flagsSrc) &&
      /adaptiveSelfEnabled: truthy\(env\.CHARACTER_ADAPTIVE_SELF_ENABLED, false\)/.test(flagsSrc),
    '两个 flag 名与缺省 false 都在场'
  )

  // -------------------------------------------------------------------------
  // D 组 —— 六态事实包
  // -------------------------------------------------------------------------
  const inputsByState: Record<ReflectionFactState, ReflectionFactInput> = {
    not_run: { hasRun: false, lastRunFailed: false, pendingCandidates: 0, acceptedReviews: 0, rejectedReviews: 0, activeAdjustments: 0, invalidatedAdjustments: 0 },
    failed: { hasRun: true, lastRunFailed: true, pendingCandidates: 0, acceptedReviews: 0, rejectedReviews: 0, activeAdjustments: 0, invalidatedAdjustments: 0 },
    candidate_pending: { hasRun: true, lastRunFailed: false, pendingCandidates: 1, acceptedReviews: 0, rejectedReviews: 0, activeAdjustments: 0, invalidatedAdjustments: 0 },
    reviewed_not_adjusted: { hasRun: true, lastRunFailed: false, pendingCandidates: 0, acceptedReviews: 1, rejectedReviews: 1, activeAdjustments: 0, invalidatedAdjustments: 0 },
    active: { hasRun: true, lastRunFailed: false, pendingCandidates: 0, acceptedReviews: 1, rejectedReviews: 0, activeAdjustments: 1, invalidatedAdjustments: 0 },
    retracted: { hasRun: true, lastRunFailed: false, pendingCandidates: 0, acceptedReviews: 1, rejectedReviews: 0, activeAdjustments: 0, invalidatedAdjustments: 1 },
  }
  const stateHits = REFLECTION_FACT_STATES.filter(
    (state) => reflectionFactStateOf(inputsByState[state]) === state
  )
  record(
    'D1',
    'D',
    '【六态可达】六个状态**各自**都能被程序读数产出（计划 §8 写"五态"但列了六项 ⇒ 如实实现六态并登记差异）',
    stateHits.length === REFLECTION_FACT_STATES.length,
    `可达=${JSON.stringify(stateHits)}`
  )
  const forbiddenByState = REFLECTION_FACT_STATES.map(
    (state) => buildReflectionFactPack(inputsByState[state]).forbiddenClaims
  )
  record(
    'D2',
    'D',
    '【不许夸大】每个状态的禁止项里都含那条最要紧的夸大（待审 ⇒ 不能说已养成习惯；生效 ⇒ 不能说永久人格）',
    forbiddenByState.every((list) => list.length > 0) &&
      buildReflectionFactPack(inputsByState.candidate_pending).forbiddenClaims.includes('声称已经养成习惯') &&
      buildReflectionFactPack(inputsByState.active).forbiddenClaims.includes('声称这是永久人格') &&
      buildReflectionFactPack(inputsByState.retracted).forbiddenClaims.includes('声称调整仍在生效'),
    `各态禁止项条数=${JSON.stringify(forbiddenByState.map((list) => list.length))}`
  )
  record(
    'D3',
    'D',
    '【可查】每个状态都有一句**程序生成**的事实句（模型只能在它的范围内措辞）',
    REFLECTION_FACT_STATES.every((state) => buildReflectionFactPack(inputsByState[state]).line.length > 0),
    `事实句=${JSON.stringify(REFLECTION_FACT_STATES.map((state) => buildReflectionFactPack(inputsByState[state]).state))}`
  )

  // -------------------------------------------------------------------------
  // E 组 —— 网关接线（结构判据 + provider 行为）
  // -------------------------------------------------------------------------
  const gatewaySrc = readFileSync(join(REPO_ROOT, 'src/kernel/app/turn-gateway.ts'), 'utf8')
  const gatewayStripped = gatewaySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  record(
    'E1',
    'E',
    '【接线】网关里**真的**有 `buildAdaptiveSelfStates` 选项、`adaptive_self_context` trace 步与 provider 挂载',
    gatewayStripped.includes('buildAdaptiveSelfStates') &&
      gatewayStripped.includes("kind: 'adaptive_self_context'") &&
      gatewayStripped.includes('createAdaptiveSelfProvider('),
    `选项=${String(gatewayStripped.includes('buildAdaptiveSelfStates'))} · trace=${String(gatewayStripped.includes("kind: 'adaptive_self_context'"))} · provider=${String(gatewayStripped.includes('createAdaptiveSelfProvider('))}`
  )
  record(
    'E2',
    'E',
    '【入模 id 只来自最终 packet】trace 的 `used_refs` 取自 `reality.selectedRefs`（被裁 ⇒ 空串）',
    gatewayStripped.includes('used_refs: reality.selectedRefs.join') &&
      gatewayStripped.includes('packet.sections.some('),
    `used_refs=${String(gatewayStripped.includes('used_refs: reality.selectedRefs.join'))}`
  )
  const mainWired = mainStripped.includes('buildAdaptiveSelfStates') && mainStripped.includes('adaptiveSelfEnabled')
  record(
    'E3',
    'E',
    '【真实入口】`main.ts` 把 `buildAdaptiveSelfStates` 挂在 `adaptiveSelfEnabled` 开关上（否则网关选项永远没人传 —— `L-M11-10` 的失败模式）',
    mainWired,
    `main.ts 含 buildAdaptiveSelfStates=${String(mainStripped.includes('buildAdaptiveSelfStates'))} · 含 adaptiveSelfEnabled=${String(mainStripped.includes('adaptiveSelfEnabled'))}`
  )
  const observabilitySrc = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/observability.ts'), 'utf8')
  record(
    'E4',
    'E',
    '【可观测性】`adaptive_self_context` 只**追加**一条 kind→stage 映射（`context`），阶段数仍是 **12**（冻结）',
    observabilitySrc.includes("adaptive_self_context: 'context'") && OBSERVABILITY_STAGES.length === 12,
    `映射在场=${String(observabilitySrc.includes("adaptive_self_context: 'context'"))} · 阶段数=${String(OBSERVABILITY_STAGES.length)}`
  )
  const providerZero = await createAdaptiveSelfProvider({ states, maxTokens: 0, quantify }).provide({
    characterId: 'char_x',
  } as never)
  const providerRoom = await createAdaptiveSelfProvider({ states, maxTokens: 300, quantify }).provide({
    characterId: 'char_x',
  } as never)
  record(
    'E5',
    'E',
    '【provider 行为】额度 0 ⇒ `provide()` 返回 `[]`；额度 300 ⇒ 1 个 section（provider 自己不读配置、不写第二个默认）',
    providerZero.length === 0 && providerRoom.length === 1,
    `额度0=${String(providerZero.length)} · 额度300=${String(providerRoom.length)}`
  )

  // -------------------------------------------------------------------------
  // F 组 —— 开发者面（隐私 DTO）与回复事实绑定
  // -------------------------------------------------------------------------
  const maskingRetracted = reflectionContentMustBeMasked({
    status: 'retracted',
    roots: ['ce:1'],
    rootVerdicts: [{ rootId: 'ce:1', usable: true }],
  })
  const maskingWithdrawn = reflectionContentMustBeMasked({
    status: 'accepted',
    roots: ['ce:1', 'ce:2'],
    rootVerdicts: [
      { rootId: 'ce:1', usable: true },
      { rootId: 'ce:2', usable: false, reason: 'source_forgotten' },
    ],
  })
  const maskingUnavailable = reflectionContentMustBeMasked({
    status: 'accepted',
    roots: ['ce:1'],
    rootVerdicts: [{ rootId: 'ce:1', usable: false, reason: 'unavailable' }],
  })
  record(
    'F1',
    'F',
    '【遮蔽三判据】整条撤回 ⇒ `retracted_reflection` · 任一根被忘 ⇒ `withdrawn_source`（带命中 id）· **读不到 ≠ 遮蔽**',
    maskingRetracted.mask === true &&
      maskingRetracted.reason === 'retracted_reflection' &&
      maskingWithdrawn.mask === true &&
      maskingWithdrawn.reason === 'withdrawn_source' &&
      maskingWithdrawn.hits.join(',') === 'ce:2' &&
      maskingUnavailable.mask === false,
    `撤回=${maskingRetracted.mask ? maskingRetracted.reason : 'no'} · 忘根=${maskingWithdrawn.mask ? `${maskingWithdrawn.reason}@${maskingWithdrawn.hits.join(',')}` : 'no'} · 读不到=${String(maskingUnavailable.mask)}`
  )

  const faceSrc = readFileSync(join(REPO_ROOT, 'src/kernel/app/reflection/developer-face.ts'), 'utf8')
  const faceStripped = faceSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const maskedBody =
    /export interface DeveloperReflectionMaskedDto[\s\S]*?\n\}/.exec(faceStripped)?.[0] ?? ''
  record(
    'F2',
    'F',
    '【遮蔽写进类型】被遮蔽那一支的**类型里没有** `focusQuestion` / `explanation`（漏遮蔽 = 编译错误）',
    maskedBody.length > 0 &&
      !maskedBody.includes('focusQuestion') &&
      !maskedBody.includes('explanation') &&
      !maskedBody.includes('revisionIntent'),
    `遮蔽支字段数=${String((maskedBody.match(/readonly /g) ?? []).length)} · 含正文=${String(maskedBody.includes('focusQuestion'))}`
  )

  const baseRecord = {
    reflectionId: 'refl:F',
    schemaVersion: 'reflection-record@1' as const,
    status: 'accepted',
    focusQuestion: '对象不明确时是否在反复确认？',
    explanation: '三个会话都出现了同一种来回确认。',
    supportHandles: ['ce:1', 'ce:2', 'ce:3'],
    counterHandles: [],
    scope: 'current_character_user',
    roots: ['ce:1', 'ce:2', 'ce:3'],
    rootCount: 3,
    conversationCount: 2,
    reviewReasons: [],
    generatedBy: { modelVersion: 'fixed@1', promptVersion: 'p@1', inputWindowFingerprint: 'fp' },
    lifecycleEventIds: ['de:1', 'de:2'],
  } satisfies ReflectionRecordState
  const visibleList = buildDeveloperReflectionList({
    records: [baseRecord],
    rootVerdicts: [{ rootId: 'ce:1', usable: true }],
  })
  const maskedList = buildDeveloperReflectionList({
    records: [{ ...baseRecord, status: 'retracted' }],
    rootVerdicts: [{ rootId: 'ce:1', usable: true }],
  })
  record(
    'F3',
    'F',
    '【DTO 行为】正常记录 ⇒ `masked:false` 且带正文；撤回记录 ⇒ `masked:true` 且**没有**正文，并进 `excluded`',
    visibleList.items[0]?.masked === false &&
      'explanation' in (visibleList.items[0] ?? {}) &&
      maskedList.items[0]?.masked === true &&
      !('explanation' in (maskedList.items[0] ?? {})) &&
      maskedList.excluded.length === 1,
    `正常记录 masked=${String(visibleList.items[0]?.masked)}（false = 可见，带正文）· 撤回记录 masked=${String(maskedList.items[0]?.masked)}（true = 无正文）· excluded=${String(maskedList.excluded.length)}`
  )
  const forbidden = DEVELOPER_REFLECTION_FORBIDDEN_EXPORT_PATTERNS
  record(
    'F4',
    'F',
    '【导出守卫】禁止形状真的挡住写入口（`writeX` / `invalidateX` / `acceptX`），且**不**误伤只读面（`buildDeveloperReflectionList` / `listReflectionRecords`）',
    forbidden.some((pattern) => pattern.test('writeReflection')) &&
      forbidden.some((pattern) => pattern.test('invalidateReflection')) &&
      forbidden.some((pattern) => pattern.test('acceptReview')) &&
      !forbidden.some((pattern) => pattern.test('buildDeveloperReflectionList')) &&
      !forbidden.some((pattern) => pattern.test('listReflectionRecords')),
    `模式数=${String(forbidden.length)}`
  )
  record(
    'F5',
    'F',
    '【能力登记】两条能力都登记且 `authority` 写明读面来源（只登记实际生产者）',
    DEVELOPER_REFLECTION_CAPABILITY_FACTS.reflections.authority.length > 0 &&
      DEVELOPER_REFLECTION_CAPABILITY_FACTS.adaptive_self.authority.length > 0 &&
      DEVELOPER_REFLECTION_CAPABILITY_FACTS.adaptive_self.availability === 'AVAILABLE',
    `能力=${JSON.stringify(Object.keys(DEVELOPER_REFLECTION_CAPABILITY_FACTS))}`
  )
  record(
    'F6',
    'F',
    '【回复事实绑定】网关把事实包的**状态与计数**记进 trace（`fact_state` / 允许与禁止项计数），且**不**扫描回复正文',
    gatewayStripped.includes('reflectionFactPack') &&
      gatewayStripped.includes('fact_state') &&
      gatewayStripped.includes('forbidden_claims_count') &&
      !gatewayStripped.includes('replyText.includes(') &&
      mainStripped.includes('buildReflectionFactPack: buildCurrentReflectionFactPack') &&
      gatewayStripped.includes('await input.buildReflectionFactPack()'),
    `网关含 fact_state=${String(gatewayStripped.includes('fact_state'))} · main 同轮动态读包=${String(mainStripped.includes('buildReflectionFactPack: buildCurrentReflectionFactPack'))}`
  )
  const bindingInput = reflectionFactInputFrom({
    reflectionStatuses: ['pending', 'accepted'],
    activeAdjustments: 1,
    invalidatedAdjustments: 0,
    lastRunFailed: false,
  })
  record(
    'F7',
    'F',
    '【绑定入参】从程序读数推出的入参能落到正确状态（pending+accepted+1 个生效调整 ⇒ `active`）',
    buildReflectionFactPack(bindingInput).state === 'active',
    `state=${buildReflectionFactPack(bindingInput).state}`
  )

  // -------------------------------------------------------------------------
  // G 组 —— **边界事实**（人审 R-1/R-2/R-4 的修法：给事实，不加措辞守卫）
  // -------------------------------------------------------------------------
  const atActiveBudget = renderAdaptiveSelfSection({ states, maxTokens: 300, quantify })[0]
  record(
    'G1',
    'G',
    '【冻结额度 300 下必须真的印出边界】`D27` 的激活额度 = 300 ⇒ 事实段 + 至少一条槽位行都要装得下',
    atActiveBudget !== undefined &&
      (atActiveBudget.sourceRefs ?? []).length >= 1 &&
      atActiveBudget.content.includes(ADAPTIVE_SELF_BOUNDARY_HEADER),
    `section=${String(atActiveBudget !== undefined)} · refs=${String((atActiveBudget?.sourceRefs ?? []).length)} · 长度=${String((atActiveBudget?.content ?? '').length)}`
  )
  record(
    'G2',
    'G',
    '【R-1 越界承诺】块里**明说**：只有三类处理方式可调整，信任/亲密度/依恋/价值观/性格与 Seed/记忆本体**不可**',
    ['只有三类处理方式可调整', ...ADAPTIVE_SELF_OUT_OF_SCOPE_AXES].every((needle) =>
      (atActiveBudget?.content ?? '').includes(needle)
    ),
    `含"只有三类"=${String((atActiveBudget?.content ?? '').includes('只有三类处理方式可调整'))} · 含不可调整=${String(ADAPTIVE_SELF_OUT_OF_SCOPE_AXES.every((axis) => (atActiveBudget?.content ?? '').includes(axis)))}`
  )
  record(
    'G3',
    'G',
    '【R-2 计数≠印证】块里明说：程序只证明**独立来源条数**，未判定内容是否互相印证',
    (atActiveBudget?.content ?? '').includes('只证明独立来源的') &&
      (atActiveBudget?.content ?? '').includes('未判定内容是否互相印证'),
    '含两条断言'
  )
  record(
    'G4',
    'G',
    '【R-4 撤回语义】块里明说两句：① 已撤回/遗忘的依据不再参与判断、可用性以资格读数为准；② 同一内容再现须重新验证、旧反思不因此恢复',
    (atActiveBudget?.content ?? '').includes('已撤回或遗忘的依据不再参与判断') &&
      (atActiveBudget?.content ?? '').includes('同一内容再现须重新验证'),
    '含两句语义'
  )
  record(
    'G5',
    'G',
    '【事实是程序文本、不是禁语表】事实段逐条**逐字**来自 `ADAPTIVE_SELF_BOUNDARY_FACTS`（块里不出现任何扫描/改写逻辑）',
    ADAPTIVE_SELF_BOUNDARY_FACTS.every((fact) => (atActiveBudget?.content ?? '').includes(fact)),
    `事实条数=${String(ADAPTIVE_SELF_BOUNDARY_FACTS.length)}`
  )
  record(
    'G6',
    'G',
    '【失败关闭】额度连**事实段**都放不下 ⇒ **整块不渲染**（不印半条边界）',
    renderAdaptiveSelfSection({ states, maxTokens: 60, quantify }).length === 0,
    `额度 60 ⇒ sections=${String(renderAdaptiveSelfSection({ states, maxTokens: 60, quantify }).length)}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 不碰别的域 + 量具自检
  // -------------------------------------------------------------------------
  const countByGroup = async (): Promise<Record<string, number>> => {
    const all = await domainEventsFor(db, characterId)
    const counts: Record<string, number> = { memory: 0, belief: 0, goal: 0, reflection: 0, other: 0 }
    for (const event of all) {
      const type = String(event.type)
      if (type.startsWith('MEMORY_')) counts.memory += 1
      else if (type.startsWith('BELIEF_')) counts.belief += 1
      else if (type.startsWith('GOAL_')) counts.goal += 1
      else if (type.startsWith('REFLECTION_') || type.startsWith('ADAPTIVE_SELF_')) counts.reflection += 1
      else counts.other += 1
    }
    return counts
  }
  const before = await countByGroup()
  for (let i = 0; i < 10; i += 1) {
    renderAdaptiveSelfSection({ states, maxTokens: 300, quantify })
    buildReflectionFactPack(inputsByState.active)
  }
  const after = await countByGroup()
  const deltas = Object.fromEntries(Object.keys(before).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]))
  record(
    'S1',
    'S',
    '【渲染/事实包都不写库】跑 10 轮后所有域事件数**一个都没变**',
    Object.values(deltas).every((delta) => delta === 0),
    `deltas=${JSON.stringify(deltas)}`
  )
  const byGroup = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S2',
    'S',
    '七组都测到**非零**条目',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup).map(([group, count]) => `${group}=${String(count)}`).join(' · ')
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failedChecks = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp8', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-context-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    checks,
    summary: { total: checks.length, passed: checks.length - failedChecks.length, failed: failedChecks.length },
    verdict: failedChecks.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'context-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp8',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'context',
    counts: { total: checks.length, passed: checks.length - failedChecks.length, failed: failedChecks.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:context:verify（额度/渲染/入模现实/六态事实包；零模型调用）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failedChecks.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failedChecks.length)}/${String(checks.length)}）`)
  process.exit(failedChecks.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:context:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
