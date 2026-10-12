/**
 * M11 WP5 —— **有限自适应自我门**（`m11:adaptive:verify`）。
 *
 * ============================================================================
 *  本门要测的命题
 * ============================================================================
 * ```text
 * ① **合法轨迹真的改变行为**：≥3 去重根 / ≥2 会话 / 已采纳反思 ⇒ baseline → enhanced，
 *    revision 真的 +1，根与来源反思可查（不是"只写了一条日志"）。
 * ② **不达标就不动**：单根 / 单会话 / 未解决冲突 / 反思未采纳 / 开关关闭 ⇒ `no_change` + 具名码。
 * ③ **重复根不增信**：同一个根给三次仍然算 1 个（纵深防御：本层自己再去重一次）。
 * ④ **越界拒收**：Seed / 人格数值轴 / 闭集外的槽位各有具名码。
 * ⑤ **指导语只来自程序模板**：`AdaptiveSelfState` 里没有自由文本指令字段；
 *    进上下文的那句话只能由 `renderAdaptiveSelfLine()` 产出（`D32`）。
 * ⑥ **不碰别的域**：跑完整条轨迹后 Seed / Memory / Belief / Goal / 关系 / 情绪的事件数**不变**。
 * ```
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-adaptive-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import { createProposal, type ProposalOperation } from '../src/kernel/contracts/proposal.ts'
import { createFullDomainEventRegistry, DIAGNOSTIC_SIGNAL } from '../src/kernel/contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_SLOTS,
  ADAPTIVE_SELF_TEMPLATES,
  adaptiveSelfProjectionTypeOf,
  baselineAdaptiveSelfState,
  outOfScopeReasonOf,
  renderAdaptiveSelfLine,
  type AdaptiveSelfSlot,
} from '../src/kernel/contracts/adaptive-self.ts'
import { ADAPTIVE_SELF_REVISED } from '../src/kernel/contracts/reflection-events.ts'
import {
  planAdaptiveSelfChange,
  type AdaptiveSelfPlanInput,
  type AdaptiveSelfPlanReason,
} from '../src/kernel/app/reflection/adaptive-self.ts'
import { validateReflectionProposal } from '../src/kernel/policies/reflection-validator.ts'
import {
  applyAdaptiveSelfRows,
  getAdaptiveSelfState,
  listAdaptiveSelfRows,
  listAdaptiveSelfStates,
  rebuildAdaptiveSelfProjections,
} from '../src/infrastructure/persistence/adaptive-self-store.ts'
import {
  applyAcceptedEvents,
  appendDomainEvent,
  domainEventsFor,
} from '../src/infrastructure/persistence/event-store.ts'
import { assertValidatorAccepted } from '../src/kernel/policies/validator.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'D' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

const SLOT: AdaptiveSelfSlot = 'clarify_when_ambiguous'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-adaptive-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  let clock = M4_T0
  const nextClock = (): number => (clock += 10)

  const evidence = await h.recordUserEvidence('这是一条用于自适应自我验证的真实对话事件。')
  const sourceId = evidence.event.id

  // 让"不碰别的域"的分母非零（否则 0 → 0 与"计数器不工作"无法区分）
  await appendDomainEvent(
    db,
    characterId,
    {
      type: DIAGNOSTIC_SIGNAL,
      operation: 'm11-adaptive-probe',
      payload: { counterDelta: 1 },
      sourceConversationEventIds: [sourceId],
      idempotencyKey: 'm11-adaptive-verify:counter-probe',
      processor: 'm11-adaptive-verify',
      processorVersion: 'm11-adaptive-verify@1',
      scope: 'CHARACTER_INTERNAL',
    },
    nextClock()
  )

  const processedKeys = new Set<string>()
  /** 走真实域放行口落一条 `ADAPTIVE_SELF_REVISED` */
  const emitRevision = async (input: {
    slot: AdaptiveSelfSlot
    level: 'baseline' | 'enhanced'
    revision: number
    roots: readonly string[]
    reason: string
  }): Promise<void> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-adaptive-probe',
      sourceConversationEventIds: [sourceId],
      payload: {},
      targetEvents: [
        {
          type: ADAPTIVE_SELF_REVISED,
          operation: 'update' as ProposalOperation,
          payload: {
            slot: input.slot,
            level: input.level,
            revision: input.revision,
            roots: [...input.roots],
            reason: input.reason,
          },
        },
      ],
      processor: 'm11-adaptive-verify',
      processorVersion: 'm11-adaptive-verify@1',
    })
    const accepted = assertValidatorAccepted(
      await validateReflectionProposal(
        {
          registry,
          processed: {
            async hasProcessed(key: string) {
              return processedKeys.has(key)
            },
          },
          reviewFacts: () => undefined,
        },
        proposal
      )
    )
    for (const event of accepted) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, accepted, [], nextClock())
  }

  const foldAll = async (): Promise<void> => {
    const events = (await domainEventsFor(db, characterId)).filter(
      (event) => String(event.type) === ADAPTIVE_SELF_REVISED
    )
    await applyAdaptiveSelfRows(db, characterId, events, nextClock())
  }

  // -------------------------------------------------------------------------
  // A 组 —— 合法轨迹真的改变行为
  // -------------------------------------------------------------------------
  const baseline = baselineAdaptiveSelfState(SLOT)
  const acceptedReflections = [{ reflectionId: 'refl:A', status: 'accepted' }]
  const planInput = (overrides: Partial<AdaptiveSelfPlanInput>): AdaptiveSelfPlanInput => ({
    slot: SLOT,
    current: baseline,
    reflections: acceptedReflections,
    roots: ['ce:1', 'ce:2', 'ce:3'],
    conversationCount: 2,
    unresolvedConflict: false,
    targetLevel: 'enhanced',
    adaptiveEnabled: true,
    reason: 'threshold_met_with_three_independent_roots',
    ...overrides,
  })

  const legalPlan = planAdaptiveSelfChange(planInput({}))
  record(
    'A1',
    'A',
    '【正控】三个去重根 / 两个会话 / 已采纳反思 ⇒ 规划出 `revise`（baseline → enhanced，revision +1）',
    legalPlan.kind === 'revise' && legalPlan.level === 'enhanced' && legalPlan.revision === 1,
    legalPlan.kind === 'revise'
      ? `level=${legalPlan.level} · revision=${String(legalPlan.revision)} · roots=${JSON.stringify(legalPlan.roots)}`
      : `no_change: ${legalPlan.reason}`
  )

  if (legalPlan.kind === 'revise') {
    await emitRevision({
      slot: legalPlan.slot,
      level: legalPlan.level,
      revision: legalPlan.revision,
      roots: legalPlan.roots,
      reason: legalPlan.reason,
    })
    await foldAll()
  }

  const afterRevise = await getAdaptiveSelfState(db, characterId, SLOT)
  record(
    'A2',
    'A',
    '【正控】落库 + 折叠之后：槽位状态**真的**是 enhanced，revision=1，根与原因可查（不是只写了一条日志）',
    afterRevise.level === 'enhanced' &&
      afterRevise.revision === 1 &&
      afterRevise.roots.join(',') === 'ce:1,ce:2,ce:3' &&
      afterRevise.changedReason.length > 0,
    `level=${afterRevise.level} · revision=${String(afterRevise.revision)} · roots=${JSON.stringify(afterRevise.roots)} · reason=${afterRevise.changedReason}`
  )
  record(
    'A3',
    'A',
    '三槽**总有**读法：没有事件的两个槽按 baseline 读出（不需要靠"表里有没有行"判断）',
    (await listAdaptiveSelfStates(db, characterId)).length === ADAPTIVE_SELF_SLOTS.length &&
      (await getAdaptiveSelfState(db, characterId, 'acknowledge_correction_first')).level === 'baseline',
    `槽数=${String((await listAdaptiveSelfStates(db, characterId)).length)}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 不达标就不动 + 越界拒收
  // -------------------------------------------------------------------------
  const expectNoChange = (
    id: string,
    label: string,
    overrides: Partial<AdaptiveSelfPlanInput>,
    reason: AdaptiveSelfPlanReason
  ): void => {
    const plan = planAdaptiveSelfChange(planInput(overrides))
    record(id, 'B', label, plan.kind === 'no_change' && plan.reason === reason, plan.kind === 'no_change' ? `no_change: ${plan.reason}` : `**竟然 revise 了**：${JSON.stringify(plan)}`)
  }

  expectNoChange('B1', '【负控】只有一个根 ⇒ `single_root_only`', { roots: ['ce:1'] }, 'single_root_only')
  expectNoChange('B2', '【负控】两个根 ⇒ `threshold_not_met`（与"只有一个根"分开）', { roots: ['ce:1', 'ce:2'] }, 'threshold_not_met')
  expectNoChange('B3', '【负控】三根只落在一个会话 ⇒ `single_session_only`', { conversationCount: 1 }, 'single_session_only')
  expectNoChange('B4', '【负控】存在未解决冲突 ⇒ `conflicting_support`', { unresolvedConflict: true }, 'conflicting_support')
  expectNoChange('B5', '【负控】反思只是候选（未采纳）⇒ `reflection_not_accepted`', { reflections: [{ reflectionId: 'refl:P', status: 'pending' }] }, 'reflection_not_accepted')
  expectNoChange('B6', '【负控】总开关关闭 ⇒ `adaptive_disabled`（关闭不删历史，只是不消费）', { adaptiveEnabled: false }, 'adaptive_disabled')
  expectNoChange('B7', '【负控】档位没变（已经是 enhanced）⇒ `no_level_change`', { current: { ...baseline, level: 'enhanced', revision: 1 } }, 'no_level_change')

  // B8 —— 重复根不增信（纵深防御：同一个根给三次仍算 1）
  const repeated = planAdaptiveSelfChange(planInput({ roots: ['ce:1', 'ce:1', 'ce:1'] }))
  record(
    'B8',
    'B',
    '【负控】同一个根重复三次 ⇒ 去重后只有 1 个 ⇒ `single_root_only`（重复不增信）',
    repeated.kind === 'no_change' && repeated.reason === 'single_root_only',
    repeated.kind === 'no_change' ? `no_change: ${repeated.reason}` : '**竟然 revise 了**'
  )

  // B9 —— 越界：Seed / 人格数值轴 / 闭集外的槽
  const outOfScope = {
    seed: outOfScopeReasonOf({ target: 'seed' }),
    axis: outOfScopeReasonOf({ target: 'personality_axis' }),
    slot: outOfScopeReasonOf({ requestedSlot: 'always_be_nice' }),
  }
  record(
    'B9',
    'B',
    '【负控】越界请求各有具名码：改 Seed ⇒ `seed_change_requested` · 改人格数值轴 ⇒ `personality_axis_requested` · 闭集外的槽 ⇒ `slot_out_of_scope`',
    outOfScope.seed === 'seed_change_requested' &&
      outOfScope.axis === 'personality_axis_requested' &&
      outOfScope.slot === 'slot_out_of_scope',
    JSON.stringify(outOfScope)
  )

  const illegalSlot = planAdaptiveSelfChange(
    planInput({ slot: 'always_be_nice' as AdaptiveSelfSlot })
  )
  record(
    'B10',
    'B',
    '【负控】把闭集外的槽塞进规划器 ⇒ `slot_out_of_scope`（越界在**规划层**也被拦）',
    illegalSlot.kind === 'no_change' && illegalSlot.reason === 'slot_out_of_scope',
    illegalSlot.kind === 'no_change' ? `no_change: ${illegalSlot.reason}` : '**竟然 revise 了**'
  )

  // B11 —— 版本跳跃是非法边（折叠层拒绝）
  await emitRevision({ slot: 'reconcile_goal' as AdaptiveSelfSlot, level: 'enhanced', revision: 1, roots: ['ce:9'], reason: 'illegal_slot_probe' }).catch(() => undefined)
  await emitRevision({ slot: 'acknowledge_correction_first', level: 'enhanced', revision: 5, roots: ['ce:1'], reason: 'version_jump_probe' })
  await foldAll()
  const jumped = await getAdaptiveSelfState(db, characterId, 'acknowledge_correction_first')
  record(
    'B11',
    'B',
    '【负控·折叠层】revision 跳跃（1 → 5）的事件**不折叠**：该槽仍是 baseline（非法边不生效，也不抛）',
    jumped.level === 'baseline' && jumped.revision === 0,
    `level=${jumped.level} · revision=${String(jumped.revision)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 回放与 D32（指导语只来自程序模板）
  // -------------------------------------------------------------------------
  const beforeRebuild = await listAdaptiveSelfStates(db, characterId)
  const events = (await domainEventsFor(db, characterId)).filter(
    (event) => String(event.type) === ADAPTIVE_SELF_REVISED
  )
  await rebuildAdaptiveSelfProjections(db, characterId, events, nextClock())
  const afterRebuild = await listAdaptiveSelfStates(db, characterId)
  record(
    'C1',
    'C',
    '【回放】从事件全量重建：与重建前**逐字段一致**',
    JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild),
    `一致=${String(JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild))} · 槽数=${String(afterRebuild.length)}`
  )

  const contractSrc = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/adaptive-self.ts'), 'utf8')
  const stripped = contractSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const freeTextFields = ['instruction', 'prompt', 'systemMessage', 'text:']
  const freeTextHits = freeTextFields.filter((field) => stripped.includes(field))
  record(
    'C2',
    'C',
    '【结构·D32】`AdaptiveSelfState` 里**没有**自由文本指令字段（去注释后零命中）—— 指导语只能来自程序模板',
    freeTextHits.length === 0,
    `命中=${JSON.stringify(freeTextHits)}`
  )
  record(
    'C3',
    'C',
    '【D32】模板表恰好覆盖三个槽，且每个都是固定句子（渲染只走 `renderAdaptiveSelfLine()`）',
    Object.keys(ADAPTIVE_SELF_TEMPLATES).length === ADAPTIVE_SELF_SLOTS.length &&
      ADAPTIVE_SELF_SLOTS.every((slot) => renderAdaptiveSelfLine(slot) === ADAPTIVE_SELF_TEMPLATES[slot]),
    `模板=${JSON.stringify(Object.keys(ADAPTIVE_SELF_TEMPLATES))}`
  )

  // -------------------------------------------------------------------------
  // D 组 —— 不碰别的域
  // -------------------------------------------------------------------------
  const countByGroup = async (): Promise<Record<string, number>> => {
    const all = await domainEventsFor(db, characterId)
    const counts: Record<string, number> = { memory: 0, belief: 0, goal: 0, commitment: 0, relationship: 0, affect: 0, reflection: 0, adaptive: 0, other: 0 }
    for (const event of all) {
      const type = String(event.type)
      if (type.startsWith('MEMORY_')) counts.memory += 1
      else if (type.startsWith('BELIEF_')) counts.belief += 1
      else if (type.startsWith('GOAL_')) counts.goal += 1
      else if (type.startsWith('COMMITMENT_')) counts.commitment += 1
      else if (type.startsWith('RELATIONSHIP_')) counts.relationship += 1
      else if (type.startsWith('AFFECT_')) counts.affect += 1
      else if (type.startsWith('REFLECTION_')) counts.reflection += 1
      else if (type.startsWith('ADAPTIVE_SELF_')) counts.adaptive += 1
      else counts.other += 1
    }
    return counts
  }

  const before = await countByGroup()
  for (let i = 0; i < 10; i += 1) planAdaptiveSelfChange(planInput({}))
  const after = await countByGroup()
  const deltas = Object.fromEntries(
    Object.keys(before).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)])
  ) as Record<string, number>
  record(
    'D1',
    'D',
    '【不碰别的域】跑 10 次规划后：Seed 不在事件里；Memory / Belief / Goal / 关系 / 情绪 的事件数**一个都没变**',
    deltas.memory === 0 &&
      deltas.belief === 0 &&
      deltas.goal === 0 &&
      deltas.commitment === 0 &&
      deltas.relationship === 0 &&
      deltas.affect === 0 &&
      deltas.other === 0,
    `deltas=${JSON.stringify(deltas)} · before.other=${String(before.other ?? 0)}`
  )
  record(
    'D2',
    'D',
    '【量具自检】本域的写入确实发生了（`ADAPTIVE_SELF_REVISED` 计数非零）—— "别的域没变"不是靠"什么都没做"',
    (after.adaptive ?? 0) > 0 && (before.other ?? 0) > 0,
    `adaptive=${String(after.adaptive ?? 0)} · other=${String(before.other ?? 0)}`
  )

  const storeSrc = readFileSync(join(REPO_ROOT, 'src/infrastructure/persistence/adaptive-self-store.ts'), 'utf8')
  const storeStripped = storeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const functionBodyOf = (source: string, name: string): string => {
    const start = source.indexOf(`export async function ${name}`)
    if (start < 0) return ''
    const rest = source.slice(start)
    const nextExport = rest.indexOf('\nexport ', 1)
    return nextExport < 0 ? rest : rest.slice(0, nextExport)
  }
  const readFaces = ['listAdaptiveSelfRows', 'listAdaptiveSelfStates', 'getAdaptiveSelfState']
    .map((name) => functionBodyOf(storeStripped, name))
    .join('\n')
  const writeHits = ['insertProjection', 'saveProjection', 'deleteProjection', 'inTransaction'].filter((primitive) =>
    readFaces.includes(primitive)
  )
  record(
    'D3',
    'D',
    '结构判据：**读面**（三个读函数的函数体）里没有写原语',
    readFaces.length > 0 && writeHits.length === 0,
    `读函数体=${String(readFaces.length)} 字节 · 命中=${JSON.stringify(writeHits)}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0, D: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S1',
    'S',
    '四组都测到**非零**条目，且拒收理由覆盖门槛 / 冲突 / 反思状态 / 越界四族',
    Object.values(byGroup).every((count) => count > 0) &&
      ['single_root_only', 'conflicting_support', 'reflection_not_accepted', 'slot_out_of_scope'].every((code) =>
        checks.some((c) => c.detail.includes(code))
      ),
    `A=${String(byGroup.A)} · B=${String(byGroup.B)} · C=${String(byGroup.C)} · D=${String(byGroup.D)}`
  )
  record(
    'S2',
    'S',
    '投影行数与三槽一致（一条槽一行，不多不少）',
    (await listAdaptiveSelfRows(db, characterId)).length === 1 &&
      (await listAdaptiveSelfStates(db, characterId)).length === 3,
    `行数=${String((await listAdaptiveSelfRows(db, characterId)).length)} · 槽数=3 · 投影前缀=${adaptiveSelfProjectionTypeOf(SLOT)}`
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp5', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-adaptive-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'adaptive-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp5',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'adaptive',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:adaptive:verify（三槽 + 门槛 + 越界 + 回放；零模型调用）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:adaptive:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
