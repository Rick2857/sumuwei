/**
 * M10 WP2 —— **引用复核门**（`pnpm m10:inputs:verify`）。
 *
 * ============================================================================
 *  这份脚本要测的命题（先写命题，再写量具）
 * ============================================================================
 * 「M10 的 Goal 依赖引用**取的是当前的真实版本**，使用前**真的重查过一次**，
 *   读不到时**失败关闭**，并且 **M9.5 交给我们的两个 fixture 保持无写入契约**。」
 *
 * 它测的是 WP0 基线报告 §3 里 Q1/Q2 点名的两个**结构性缺口**：
 * ```text
 * 缺口 ①  M9.5 fixture 把 `sourceRevision` 固定为 1        → 这里 I1/I2/I3
 * 缺口 ②  它的"复核"只是消费者传入的回调                  → 这里 I3/I4/I5/I6/I8/I9
 * ```
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库（本文件顶部、**任何**数据库 import 之前）；
 *    真实库**从不被打开**（不取租约、不建连接、不迁移）。
 *  · **零模型调用、零出网**。
 *  · 每条计数型检查都有非零分母；`measuredCount` 与**计数守恒**都自检（AGENTS §6.8）。
 *  · 静态检查只读源码文本；不修改任何文件。
 *  · 探针用**真实生产函数**（`captureMemoryReference` / `recheckGoalDependencies` /
 *    `applyGoalInvalidationOverlay` / `createGoalInputPorts` / M4 harness），
 *    **不是**复制品。
 *
 * ============================================================================
 *  正控 / 负控（两侧都要有，否则量具与"什么都不检查"无法区分）
 * ============================================================================
 *  · **负控**：旧引用必须失效（`I3`）· 遗忘/撤销必须挡住（`I5`/`I8`）·
 *    跨角色/跨用户必须拒（`I6`/`I6b`）· 读失败必须全体不可用（`I7`）·
 *    撤销集有缺口必须失败关闭（`I9`）· 状态不可用必须报（`I4b`/`I11`）。
 *  · **正控**：**未**被修订的有效引用必须 `hard`（`I4`）· reported+active 必须 `hard`（`I10`）·
 *    一轮多次复核只读一次（`I13`）。
 *  只做负控的实现可以靠"永远拒绝"通过；只做正控的可以靠"永远接受"通过。
 *
 * ⚠️ **本门不做量具三段式**（注入坏实现 ⇒ 变红 ⇒ 恢复再绿）：那是 WP8 的
 *    `m10:measurement:verify` 的职责（契约 §7）。本节只声明并执行正/负两侧读数。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-inputs-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { M4_T0, countsOf, createM4Harness, type M4Harness } from './m4-harness.ts'
import type { CharacterId, MemoryId } from '../src/kernel/contracts/ids.ts'
import type { CharacterProjection } from '../src/kernel/contracts/projection.ts'
import {
  REFERENCE_REJECTION_FACTS,
  REFERENCE_REJECTION_REASONS,
  dependencyKeyOf,
  usableAsNecessaryPremise,
  usableAsOptionalBackground,
  type BeliefReference,
  type GoalDependencyRef,
  type MemoryReference,
  type ReferenceRejectionReason,
  type ReferenceUsability,
} from '../src/kernel/contracts/goal-reference.ts'
import type { WithdrawnSetResult } from '../src/kernel/contracts/withdrawn-evidence.ts'
import {
  applyGoalInvalidationOverlay,
  captureBeliefReference,
  captureMemoryReference,
  recheckGoalDependencies,
  type GoalBeliefLookup,
  type GoalDependencyRecheckReport,
  type GoalInputPorts,
  type GoalMemoryLookup,
} from '../src/kernel/app/goal/inputs.ts'
import {
  goalFixtureConsume,
  reflectionFixtureConsume,
  referencesFromOutcome,
  type RecallReference,
} from '../src/kernel/app/recall/handoff-fixtures.ts'
import type { RecallTurnOutcome } from '../src/kernel/app/recall/turn.ts'
import { beliefRowKeyOf } from '../src/kernel/projections/belief.ts'
import { insertProjection } from '../src/infrastructure/persistence/event-store.ts'
import { createGoalInputPorts } from '../src/infrastructure/persistence/goal-input-store.ts'

const REPO_ROOT = resolve(process.cwd())

/**
 * 本轮角色 / 用户的**真实**标识。
 *
 * ⚠️ WP2 第一版把 `characterId` 硬编码成 `char_m10_inputs` 传给 `createM4Harness`，
 *    于是 `h.owner.id` 是那个值、而 `h.kernel.characterId` 是**角色定义自己的 id**
 *    （`00000000-0000-4000-8000-000000000001`）—— 两者不等。
 *    `createGoalInputPorts` 的构造期一致性检查**当场把它拦下**（这正是那条检查的用途），
 *    但教训是：本门**不得**自造角色 id，必须用夹具给的那一套。
 */
interface InputsContext {
  characterId: string
  activeUserId: string
}
let ctx: InputsContext = { characterId: '', activeUserId: '' }

/**
 * 阶段进度（**stderr**）。
 *
 * 为什么需要它：门脚本只在**最后**打印结果，因此"卡在哪一步"在超时时完全不可见
 * （WP2 第一版实测：无输出地挂了 >10 分钟，只能靠进程 CPU 判断它是**阻塞**而非空转）。
 * 它只写阶段名，不含任何数据 —— 不污染 stdout 的判据输出。
 */
function phase(mark: string): void {
  console.error(`[m10-inputs] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
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

function readSrc(relPath: string): string {
  const abs = join(REPO_ROOT, relPath)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

/** 判定 → 可读形状（只用于**报告**；断言一律直接看原始 verdict） */
type Outcome =
  | { kind: 'ok'; as: 'hard' | 'soft' }
  | { kind: 'rejected'; reason: ReferenceRejectionReason }
  | { kind: 'missing' }

function shapeOf(verdict: ReferenceUsability | undefined): Outcome {
  if (verdict === undefined) return { kind: 'missing' }
  if (verdict.usable) return { kind: 'ok', as: verdict.as }
  return { kind: 'rejected', reason: verdict.reason }
}

function describeOutcome(verdict: ReferenceUsability | undefined): string {
  const outcome = shapeOf(verdict)
  if (outcome.kind === 'missing') return '(缺判定)'
  if (outcome.kind === 'ok') return `usable:${outcome.as}`
  return `rejected:${outcome.reason}`
}

function verdictFor(
  report: GoalDependencyRecheckReport,
  dep: GoalDependencyRef,
): ReferenceUsability | undefined {
  return report.verdicts.get(dependencyKeyOf(dep))
}

function rejectedAs(
  verdict: ReferenceUsability | undefined,
  reason: ReferenceRejectionReason,
): boolean {
  return verdict !== undefined && !verdict.usable && verdict.reason === reason
}

// ---------------------------------------------------------------------------
// 静态事实
// ---------------------------------------------------------------------------

function staticChecks(): void {
  const fixtures = readSrc('src/kernel/app/recall/handoff-fixtures.ts')
  const fixtureImports = [...fixtures.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((m) => m[1]!)
  const writeCapable = fixtureImports.filter((spec) =>
    /infrastructure|persistence|node:|drizzle|elizaos/.test(spec),
  )
  record(
    'S1',
    'M9.5 的两个 fixture **没有**任何具有写入能力的依赖（只 import 纯类型）',
    '0 条写入能力 import',
    `imports=[${fixtureImports.join(', ')}] · 可疑=${writeCapable.join(',') || '无'}`,
    writeCapable.length === 0 && fixtureImports.length > 0,
  )

  const factKeys = Object.keys(REFERENCE_REJECTION_FACTS)
  const keysMatch =
    factKeys.length === REFERENCE_REJECTION_REASONS.length &&
    REFERENCE_REJECTION_REASONS.every((reason) => factKeys.includes(reason))
  record(
    'S2',
    '拒绝原因闭集与可达性事实表**键完全一致**（防"枚举加了、事实表忘加"）',
    `${String(REFERENCE_REJECTION_REASONS.length)} 个原因 ↔ ${String(factKeys.length)} 条事实`,
    `枚举=[${REFERENCE_REJECTION_REASONS.join(',')}] · 事实键=[${factKeys.join(',')}] · 一致=${String(keysMatch)}`,
    keysMatch,
  )

  const unreachable = REFERENCE_REJECTION_REASONS.filter(
    (reason) => !REFERENCE_REJECTION_FACTS[reason].reachable,
  )
  record(
    'S3',
    'WP2 声称这些原因**全部**有生产者（没有"表达得了但永远出不来"的值）',
    '0 个不可达',
    `不可达=${unreachable.join(',') || '无'}`,
    unreachable.length === 0,
  )

  const inputs = readSrc('src/kernel/app/goal/inputs.ts')
  const batchPorts =
    inputs.includes('findMemories(ids: readonly string[])') &&
    inputs.includes('findBeliefs(ids: readonly string[])')
  record(
    'S4',
    '端口是**批量形状**（`findMemories(ids)` / `findBeliefs(ids)`）—— 与 M9 的 `findEvents(ids)` 同形',
    '两个批量签名都在',
    `findMemories=${String(inputs.includes('findMemories(ids: readonly string[])'))} · findBeliefs=${String(inputs.includes('findBeliefs(ids: readonly string[])'))}`,
    batchPorts,
  )

  const goalModules = [
    readSrc('src/kernel/contracts/goal-reference.ts'),
    readSrc('src/kernel/app/goal/inputs.ts'),
    readSrc('src/infrastructure/persistence/goal-input-store.ts'),
  ].join('\n')
  record(
    'S5',
    'Goal 输入层**没有**任何写死的 `sourceRevision: 1`（缺口 ① 的形状不得复活）',
    '0 处固定版本',
    goalModules.includes('sourceRevision: 1') ? '发现固定值（缺口复现）' : '无固定版本',
    !goalModules.includes('sourceRevision: 1'),
  )
}

// ---------------------------------------------------------------------------
// 端口替身（只用于"注入一个坏/特殊读数"的负控）
// ---------------------------------------------------------------------------

function portsWith(overrides: {
  memory?: GoalMemoryLookup
  belief?: GoalBeliefLookup
  withdrawn?: GoalInputPorts['withdrawn']
  policy?: GoalInputPorts['policy']
}): GoalInputPorts {
  return {
    memory: overrides.memory ?? { findMemories: async () => [] },
    belief: overrides.belief ?? { findBeliefs: async () => [] },
    withdrawn:
      overrides.withdrawn ?? {
        compute: async (): Promise<WithdrawnSetResult> => ({
          ok: true,
          withdrawnEventIds: [],
          byReason: {},
          gaps: [],
          measuredCount: 1,
        }),
      },
    policy: overrides.policy ?? {
      characterId: ctx.characterId,
      activeUserId: ctx.activeUserId,
    },
  }
}

function activeMemoryReading(input: {
  id: string
  ownerId?: string
  subjectKeys?: readonly string[]
  evidenceIds?: readonly string[]
  revision?: number
  status?: string
}): {
  id: string
  ownerKind: string
  ownerId: string
  subjectKeys: readonly string[]
  status: string
  revision: number
  evidenceIds: readonly string[]
} {
  return {
    id: input.id,
    ownerKind: 'character',
    ownerId: input.ownerId ?? ctx.characterId,
    subjectKeys: input.subjectKeys ?? [`user:${ctx.activeUserId}`],
    status: input.status ?? 'active',
    revision: input.revision ?? 1,
    evidenceIds: input.evidenceIds ?? [],
  }
}

// ---------------------------------------------------------------------------
// 主实验：Memory 侧
// ---------------------------------------------------------------------------

async function memorySide(h: M4Harness, ports: GoalInputPorts): Promise<void> {
  // ---- I1/I2/I3：真实 revision 与旧引用失效 ----
  const ev = await h.recordUserEvidence('记住：我正在写一篇关于长期记忆的论文。')
  const created = await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject: h.user,
        predicate: 'project.background.active',
        value: '长期记忆论文',
      },
      { sourceRefs: [ev.ref] },
    ),
    M4_T0 + 100,
  )
  if (created === null) throw new Error('I1 前置失败：创建记忆被拒')
  const createdDep: GoalDependencyRef = { kind: 'memory', memoryId: String(created.id) }

  const first = await captureMemoryReference(ports, String(created.id))
  record(
    'I1',
    '捕获引用取到**真实** revision（新建记录 = 1，不是写死的常量）',
    'captured=true · sourceRevision=1',
    first.captured
      ? `captured=true · sourceRevision=${String(first.reference.sourceRevision)}`
      : `captured=false · ${first.reason}`,
    first.captured && first.reference.sourceRevision === 1,
  )

  const ev2 = await h.recordUserEvidence('更正一下，方向改成持续角色 Agent 了。')
  const replacement = (await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject: h.user,
        predicate: 'project.background.active',
        value: '持续角色 Agent',
      },
      { sourceRefs: [ev2.ref] },
    ),
    M4_T0 + 200,
  ))!
  await h.applyStateChange(
    'supersede',
    ev2.ref.id,
    {
      memoryId: created.id,
      supersededBy: replacement.id,
      validUntil: M4_T0 + 200,
      reason: '用户更正方向',
    },
    M4_T0 + 200,
  )
  const second = await captureMemoryReference(ports, String(created.id))
  record(
    'I2',
    '同一条记录被修订后**重新捕获**取到新 revision（= 2）',
    'captured=true · sourceRevision=2',
    second.captured
      ? `captured=true · sourceRevision=${String(second.reference.sourceRevision)}`
      : `captured=false · ${second.reason}`,
    second.captured && second.reference.sourceRevision === 2,
  )

  const staleRefs = new Map<string, MemoryReference>()
  if (first.captured) staleRefs.set(String(created.id), first.reference)
  const staleVerdict = verdictFor(
    await recheckGoalDependencies(ports, [createdDep], { memoryReferences: staleRefs }),
    createdDep,
  )
  record(
    'I3',
    '【负控】拿 rev1 的**旧引用**去复核 ⇒ 必须失效（`revision_changed`）',
    'rejected:revision_changed',
    describeOutcome(staleVerdict),
    rejectedAs(staleVerdict, 'revision_changed'),
  )

  // ---- I4 / I4b：正控（有效引用可用）+ 状态闸（superseded 不可用） ----
  const activeDep: GoalDependencyRef = {
    kind: 'memory',
    memoryId: String(replacement.id),
  }
  const activeCapture = await captureMemoryReference(ports, String(replacement.id))
  const freshRefs = new Map<string, MemoryReference>()
  if (activeCapture.captured) freshRefs.set(String(replacement.id), activeCapture.reference)
  const activeReport = await recheckGoalDependencies(ports, [activeDep], {
    memoryReferences: freshRefs,
  })
  const activeVerdict = verdictFor(activeReport, activeDep)
  record(
    'I4',
    '【正控】**未**被修订的 active 记录，用刚捕获的引用复核 ⇒ 必须 `usable:hard`（不能只会拒绝）',
    'usable:hard · measuredCount=1',
    `${describeOutcome(activeVerdict)} · measuredCount=${String(activeReport.measuredCount)}`,
    activeVerdict !== undefined &&
      activeVerdict.usable &&
      activeVerdict.as === 'hard' &&
      activeReport.measuredCount === 1,
  )

  const supersededVerdict = verdictFor(
    await recheckGoalDependencies(ports, [createdDep]),
    createdDep,
  )
  record(
    'I4b',
    '【负控·状态闸】已被取代的记录（不在撤销集里）⇒ `status_not_usable`',
    'rejected:status_not_usable',
    describeOutcome(supersededVerdict),
    rejectedAs(supersededVerdict, 'status_not_usable'),
  )

  // ---- I5：被遗忘的记录（它自己的证据就在撤销集里） ----
  const evForget = await h.recordUserEvidence('忘掉持续角色 Agent 方向的事。')
  await h.applyStateChange(
    'retract',
    evForget.ref.id,
    { memoryId: replacement.id, reason: 'explicit_forget', note: '用户要求忘掉' },
    M4_T0 + 300,
  )
  const forgottenVerdict = verdictFor(
    await recheckGoalDependencies(ports, [activeDep]),
    activeDep,
  )
  record(
    'I5',
    '【负控·遗忘】被遗忘的记录 ⇒ `forgotten`（它自己的来源事件就在撤销集里；'
      + '这一条比 `status_not_usable` 更具体，因此优先报它）',
    'rejected:forgotten',
    describeOutcome(forgottenVerdict),
    rejectedAs(forgottenVerdict, 'forgotten'),
  )

  // ---- I6 / I6b：身份隔离 ----
  const foreignDep: GoalDependencyRef = { kind: 'memory', memoryId: 'mem:someone-else' }
  const foreignVerdict = verdictFor(
    await recheckGoalDependencies(
      portsWith({
        memory: {
          findMemories: async () => [
            activeMemoryReading({ id: 'mem:someone-else', ownerId: 'char_someone_else' }),
          ],
        },
      }),
      [foreignDep],
    ),
    foreignDep,
  )
  record(
    'I6',
    '【负控】owner 不是本角色 ⇒ `foreign`（跨角色一律拒）',
    'rejected:foreign',
    describeOutcome(foreignVerdict),
    rejectedAs(foreignVerdict, 'foreign'),
  )

  const foreignSubjectDep: GoalDependencyRef = {
    kind: 'memory',
    memoryId: 'mem:other-user',
  }
  const foreignSubjectVerdict = verdictFor(
    await recheckGoalDependencies(
      portsWith({
        memory: {
          findMemories: async () => [
            activeMemoryReading({
              id: 'mem:other-user',
              subjectKeys: ['user:someone_else'],
            }),
          ],
        },
      }),
      [foreignSubjectDep],
    ),
    foreignSubjectDep,
  )
  record(
    'I6b',
    '【负控】subject 是**另一个用户** ⇒ `foreign`（跨用户泄漏）',
    'rejected:foreign',
    describeOutcome(foreignSubjectVerdict),
    rejectedAs(foreignSubjectVerdict, 'foreign'),
  )

  // ---- I7：读失败 ⇒ 全体 unavailable（失败关闭） ----
  const twoDeps: GoalDependencyRef[] = [
    { kind: 'memory', memoryId: 'mem:a' },
    { kind: 'memory', memoryId: 'mem:b' },
  ]
  const failedReport = await recheckGoalDependencies(
    portsWith({
      memory: {
        findMemories: async () => {
          throw new Error('注入的读失败（负控）')
        },
      },
    }),
    twoDeps,
  )
  const failedVerdicts = twoDeps.map((dep) => verdictFor(failedReport, dep))
  record(
    'I7',
    '【负控·失败关闭】读端口抛错 ⇒ **全体** `unavailable`（既不 usable，也不当"不存在"）',
    '两条都 unavailable · measuredCount=0',
    `${failedVerdicts.map((v) => describeOutcome(v)).join(' · ')} · measuredCount=${String(failedReport.measuredCount)}`,
    failedVerdicts.every((v) => rejectedAs(v, 'unavailable')) &&
      failedReport.counts.rejected === 2 &&
      failedReport.measuredCount === 0,
  )

  // ---- I8：共享来源事件的另一条记录也必须被遮蔽 ----
  const sharedEv = await h.recordUserEvidence('记住：我喜欢香菜；另外我在写一个长期项目。')
  const sharedA = (await h.commitAndFold(
    h.makeCandidate(
      'preference',
      { kind: 'claim', subject: h.user, predicate: 'food.preference.cilantro', value: 'like' },
      { sourceRefs: [sharedEv.ref] },
    ),
    M4_T0 + 400,
  ))!
  const sharedB = (await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject: h.user,
        predicate: 'project.background.active',
        value: 'm10-inputs-shared-source',
      },
      { sourceRefs: [sharedEv.ref] },
    ),
    M4_T0 + 410,
  ))!
  await h.applyStateChange(
    'retract',
    sharedEv.ref.id,
    { memoryId: sharedA.id, reason: 'explicit_forget', note: '忘掉香菜偏好' },
    M4_T0 + 420,
  )
  const sharedDep: GoalDependencyRef = { kind: 'memory', memoryId: String(sharedB.id) }
  const sharedReading = await h.store.get(sharedB.id as MemoryId)
  const sharedReport = await recheckGoalDependencies(ports, [sharedDep])
  const sharedVerdict = verdictFor(sharedReport, sharedDep)
  record(
    'I8',
    '【负控·遗忘通路】与遗忘项**共享同一来源事件**、且自己仍 active 的记录 ⇒ `forgotten`'
      + '（与 M9.1 遮蔽那一段对话行是同一条语义）',
    '另一条仍 active，但复核 = rejected:forgotten',
    `另一条 status=${String(sharedReading?.status ?? '(读不到)')} · 复核=${describeOutcome(sharedVerdict)} · 撤销集 measured=${String(sharedReport.counts.withdrawn.measuredCount)}`,
    sharedReading?.status === 'active' && rejectedAs(sharedVerdict, 'forgotten'),
  )

  // ---- I9：撤销集有具名缺口 ⇒ withdrawn_incomplete ----
  const gapDep: GoalDependencyRef = { kind: 'memory', memoryId: 'mem:gapped' }
  const gapVerdict = verdictFor(
    await recheckGoalDependencies(
      portsWith({
        memory: {
          findMemories: async () => [
            activeMemoryReading({ id: 'mem:gapped', evidenceIds: ['cev:not-withdrawn'] }),
          ],
        },
        withdrawn: {
          compute: async () => ({
            ok: false,
            withdrawnEventIds: [],
            byReason: {},
            gaps: ['reason_missing:mem-x（按 explicit_forget 最宽处理）'],
            measuredCount: 3,
          }),
        },
      }),
      [gapDep],
    ),
    gapDep,
  )
  record(
    'I9',
    '【负控·失败关闭】撤销集有**具名缺口** ⇒ `withdrawn_incomplete`（无法证明"未被遗忘"，宁过遮不漏）',
    'rejected:withdrawn_incomplete',
    describeOutcome(gapVerdict),
    rejectedAs(gapVerdict, 'withdrawn_incomplete'),
  )
}

// ---------------------------------------------------------------------------
// 主实验：Belief 侧（直接插投影行；只读面探针）
// ---------------------------------------------------------------------------

interface BeliefProbeInput {
  beliefId: string
  projectionRevision: number
  status: string
  epistemicKind: string
  supportLevel: string
  evidenceRootIds: string[]
  dependsOnMemoryIds: string[]
  subjectKind?: string
  subjectId?: string
  perspectiveOwnerId?: string
}

async function beliefSide(h: M4Harness, ports: GoalInputPorts): Promise<void> {
  const characterId = h.kernel.characterId as CharacterId
  const characterKey = String(characterId)

  const insertBeliefRow = async (input: BeliefProbeInput): Promise<void> => {
    /*
     * 合成投影行：只填**读侧要用的字段**。`proposition` 等字段不参与本门的判定，
     * 因此这里不伪造它们的语义（JSON 里缺失 = 缺失，不是"填了个假的"）。
     */
    const projection: CharacterProjection<unknown> = {
      characterId,
      projectionType: beliefRowKeyOf(input.beliefId),
      revision: input.projectionRevision,
      reducerVersion: 'belief-fold@1',
      state: {
        beliefId: input.beliefId,
        perspectiveOwnerId: input.perspectiveOwnerId ?? characterKey,
        subject: { kind: input.subjectKind ?? 'user', id: input.subjectId ?? ctx.activeUserId },
        epistemicKind: input.epistemicKind,
        status: input.status,
        supportLevel: input.supportLevel,
        evidenceRefs: [],
        evidenceRootIds: input.evidenceRootIds,
        dependsOnMemoryIds: input.dependsOnMemoryIds,
        ruleId: 'm10-inputs-probe',
        ruleVersion: 'm10-inputs-probe@1',
      },
      updatedAt: M4_T0 + 500,
    }
    await insertProjection(h.db, projection, M4_T0 + 500)
  }

  await insertBeliefRow({
    beliefId: 'blf:reported',
    projectionRevision: 7,
    status: 'active',
    epistemicKind: 'reported',
    supportLevel: 'supported',
    evidenceRootIds: ['cev:r1'],
    dependsOnMemoryIds: ['mem:dep-1'],
  })
  await insertBeliefRow({
    beliefId: 'blf:inferred',
    projectionRevision: 3,
    status: 'active',
    epistemicKind: 'inferred',
    supportLevel: 'tentative',
    evidenceRootIds: ['cev:i1'],
    dependsOnMemoryIds: [],
  })
  await insertBeliefRow({
    beliefId: 'blf:disputed',
    projectionRevision: 2,
    status: 'disputed',
    epistemicKind: 'reported',
    supportLevel: 'supported',
    evidenceRootIds: ['cev:d1'],
    dependsOnMemoryIds: [],
  })
  await insertBeliefRow({
    beliefId: 'blf:retracted',
    projectionRevision: 4,
    status: 'retracted',
    epistemicKind: 'reported',
    supportLevel: 'supported',
    evidenceRootIds: ['cev:x1'],
    dependsOnMemoryIds: [],
  })

  // ---- I12：投影行版本 ----
  const reportedCapture = await captureBeliefReference(ports, 'blf:reported')
  record(
    'I12',
    'Belief 引用的 `projectionRevision` 来自**投影行**（插一行 revision=7 ⇒ 读到 7），且 epistemic 标签随行',
    'captured=true · projectionRevision=7 · reported/supported',
    reportedCapture.captured
      ? `captured=true · projectionRevision=${String(reportedCapture.reference.projectionRevision)} · ${reportedCapture.reference.epistemicKind}/${reportedCapture.reference.supportLevel}`
      : `captured=false · ${reportedCapture.reason}`,
    reportedCapture.captured &&
      reportedCapture.reference.projectionRevision === 7 &&
      reportedCapture.reference.epistemicKind === 'reported' &&
      reportedCapture.reference.supportLevel === 'supported',
  )

  const beliefDeps: GoalDependencyRef[] = [
    { kind: 'belief', beliefId: 'blf:reported' },
    { kind: 'belief', beliefId: 'blf:inferred' },
    { kind: 'belief', beliefId: 'blf:disputed' },
    { kind: 'belief', beliefId: 'blf:retracted' },
    { kind: 'belief', beliefId: 'blf:absent' },
  ]
  const beliefReport = await recheckGoalDependencies(ports, beliefDeps)
  const reported = verdictFor(beliefReport, beliefDeps[0]!)
  const inferred = verdictFor(beliefReport, beliefDeps[1]!)
  const disputed = verdictFor(beliefReport, beliefDeps[2]!)
  const retracted = verdictFor(beliefReport, beliefDeps[3]!)
  const absent = verdictFor(beliefReport, beliefDeps[4]!)

  record(
    'I10',
    '【正控 + 结构性】reported+active ⇒ `hard`；**inferred+active ⇒ `soft`**（可作背景，**不得**作硬前提）',
    'reported=usable:hard · inferred=usable:soft',
    `reported=${describeOutcome(reported)} · inferred=${describeOutcome(inferred)}`,
    reported !== undefined &&
      reported.usable &&
      reported.as === 'hard' &&
      inferred !== undefined &&
      inferred.usable &&
      inferred.as === 'soft',
  )

  record(
    'I11',
    'disputed ⇒ `soft`（不静默挑一边当确定前提）；retracted ⇒ `status_not_usable`；不存在 ⇒ `root_missing`',
    'disputed=soft · retracted=status_not_usable · absent=root_missing',
    `disputed=${describeOutcome(disputed)} · retracted=${describeOutcome(retracted)} · absent=${describeOutcome(absent)}`,
    disputed !== undefined &&
      disputed.usable &&
      disputed.as === 'soft' &&
      rejectedAs(retracted, 'status_not_usable') &&
      rejectedAs(absent, 'root_missing'),
  )

  // ---- I13：一次复核只读一次（批量 · 去重） ----
  let memoryCalls = 0
  const countingPorts: GoalInputPorts = {
    ...ports,
    memory: {
      findMemories: async (ids) => {
        memoryCalls += 1
        return ports.memory.findMemories(ids)
      },
    },
  }
  const dupDeps: GoalDependencyRef[] = [
    { kind: 'memory', memoryId: 'mem:dup-a' },
    { kind: 'memory', memoryId: 'mem:dup-a' },
    { kind: 'memory', memoryId: 'mem:dup-a' },
    { kind: 'memory', memoryId: 'mem:dup-b' },
    { kind: 'memory', memoryId: 'mem:dup-b' },
  ]
  const dupReport = await recheckGoalDependencies(countingPorts, dupDeps)
  record(
    'I13',
    '【正控·批量】同一批里重复的依赖被**去重**，且端口只被调用**一次**（N+1 在编排层写不出来）',
    'total=2 · memoryCalls=1',
    `total=${String(dupReport.counts.total)} · memoryCalls=${String(memoryCalls)}`,
    dupReport.counts.total === 2 && memoryCalls === 1,
  )

  // ---- I14：同轮 overlay（纯函数 · 只降档 · 不升档） ----
  const overlayDeps: GoalDependencyRef[] = [
    { kind: 'belief', beliefId: 'blf:reported' },
    { kind: 'belief', beliefId: 'blf:retracted' },
  ]
  const beliefRefs = new Map<string, BeliefReference>()
  if (reportedCapture.captured) beliefRefs.set('blf:reported', reportedCapture.reference)
  const overlaid = applyGoalInvalidationOverlay(
    beliefReport,
    overlayDeps,
    /* 空数组是**刻意的**：它证明"根刚失效"这一支**不依赖** memory-id 支就能命中 */
    { invalidatedMemoryIds: [], invalidatedRootIds: ['cev:r1'] },
    { beliefReferences: beliefRefs },
  )
  const overlaidVerdict = verdictFor(overlaid, overlayDeps[0]!)
  const alreadyBad = verdictFor(overlaid, overlayDeps[1]!)
  record(
    'I14',
    '【正控 + 不升档】同轮 overlay：引用带证据指针 ⇒ 根刚失效的那条变 `overlaid`；'
      + '本来就不可用的那条**保持原原因**（overlay 只降档）',
    'reported→overlaid · retracted→status_not_usable（原样）',
    `reported=${describeOutcome(overlaidVerdict)} · retracted=${describeOutcome(alreadyBad)}`,
    rejectedAs(overlaidVerdict, 'overlaid') &&
      rejectedAs(alreadyBad, 'status_not_usable') &&
      overlaid.counts.byReason.overlaid === 1,
  )

  // ---- I15：计数守恒 ----
  const counts = beliefReport.counts
  const reasonSum = REFERENCE_REJECTION_REASONS.reduce(
    (sum, reason) => sum + counts.byReason[reason],
    0,
  )
  record(
    'I15',
    '【量具自检】计数守恒：`total = hard + soft + rejected` 且 `ΣbyReason = rejected`；`measuredCount > 0`',
    '两侧等式都成立，measuredCount > 0',
    `total=${String(counts.total)} / hard=${String(counts.hard)} / soft=${String(counts.soft)} / rejected=${String(counts.rejected)} · ΣbyReason=${String(reasonSum)} · measured=${String(beliefReport.measuredCount)}`,
    counts.total === counts.hard + counts.soft + counts.rejected &&
      reasonSum === counts.rejected &&
      beliefReport.measuredCount > 0,
  )

  // ---- I16：必要前提 vs 可选背景（类型层面的分开） ----
  record(
    'I16',
    '【结构性】同一份判定：`usableAsNecessaryPremise` 只认 `hard`；`usableAsOptionalBackground` 认 hard+soft',
    'inferred：necessary=false · background=true',
    `necessary=${String(inferred !== undefined && usableAsNecessaryPremise(inferred))} · background=${String(inferred !== undefined && usableAsOptionalBackground(inferred))}`,
    inferred !== undefined &&
      !usableAsNecessaryPremise(inferred) &&
      usableAsOptionalBackground(inferred),
  )
}

// ---------------------------------------------------------------------------
// fixture 无写入契约（行为 + 静态）
// ---------------------------------------------------------------------------

async function fixtureNoWriteCheck(h: M4Harness): Promise<void> {
  const before = await countsOf(h.db, h.owner)
  /*
   * 只喂 fixture **真正用到**的字段（`referencesFromOutcome` 读 `trace.selectedIds`；
   * 两个 consume 函数只用 references / recheck）。目的不是重测召回，
   * 而是测它们的**无写入**性质 —— 因此不构造完整 outcome。
   */
  const outcome = {
    trace: { selectedIds: ['mem:fixture-1', 'mem:fixture-2'] },
  } as unknown as RecallTurnOutcome

  const references: readonly RecallReference[] = referencesFromOutcome(
    outcome,
    new Map([
      ['mem:fixture-1', ['cev:f1']],
      ['mem:fixture-2', ['cev:f2']],
    ]),
  )
  const recheck = { stillValid: (): boolean => true }

  const goalOut = goalFixtureConsume({ outcome, references, recheck })
  const reflectionOut = reflectionFixtureConsume({ outcome, references, recheck })
  const after = await countsOf(h.db, h.owner)
  const countsUnchanged = JSON.stringify(before) === JSON.stringify(after)

  record(
    'I17',
    'M9.5 两个 fixture 的**无写入契约**保持：消费后计数逐字段不变，'
      + '且 `executionAuthorizations` / `newCommitments` / `stateWrites` 均为空',
    '计数不变 · 三个出口数组都为空 · planningInputs 非空',
    `planningInputs=${String(goalOut.planningInputs.length)} · execAuth=${String(goalOut.executionAuthorizations.length)} · newCommitments=${String(goalOut.newCommitments.length)} · stateWrites=${String(reflectionOut.stateWrites.length)} · countsUnchanged=${String(countsUnchanged)}`,
    countsUnchanged &&
      goalOut.executionAuthorizations.length === 0 &&
      goalOut.newCommitments.length === 0 &&
      reflectionOut.stateWrites.length === 0 &&
      goalOut.planningInputs.length > 0,
  )

  // 静态：fixture 的 `sourceRevision` 固定值**仍在**（本步不改写它 —— 它是 M9.5 的契约）
  const fixtures = readSrc('src/kernel/app/recall/handoff-fixtures.ts')
  record(
    'I18',
    '【不改写】fixture 的 `sourceRevision: 1` **仍在原处**（M9.5 §4.4 的可执行契约一字未改；'
      + '生产引用走新模块）',
    'fixture 里仍有固定值（预期形态）',
    fixtures.includes('sourceRevision: 1') ? '仍在（预期）' : '已被改写（与预期不符）',
    fixtures.includes('sourceRevision: 1'),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  phase('static')
  staticChecks()

  phase('createM4Harness')
  const h = await createM4Harness({ label: 'm10-inputs-verify' })
  /*
   * ⚠️ 角色的真实标识**只从夹具取**：`h.owner`（记忆属主）与 `h.kernel.characterId`
   *    必须同源。自造一个 id 会让两者不等（WP2 第一版的真实教训）。
   */
  ctx = { characterId: String(h.owner.id), activeUserId: h.userId }
  phase(`createGoalInputPorts（characterId=${ctx.characterId}）`)
  const ports = createGoalInputPorts({
    db: h.db,
    store: h.store,
    owner: h.owner,
    policy: { characterId: String(h.kernel.characterId), activeUserId: h.userId },
  })
  phase('ports ready')
  try {
    phase('memorySide')
    await memorySide(h, ports)
    phase('beliefSide')
    await beliefSide(h, ports)
    phase('fixtureNoWriteCheck')
    await fixtureNoWriteCheck(h)
    phase('experiments done')
  } finally {
    phase('harness stop')
    await h.stop()
    phase('harness stopped')
  }

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp2-inputs', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const payload = {
    schema: 'm10-inputs-verify@1',
    runId,
    head,
    characterId: ctx.characterId,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
  }
  writeFileSync(join(dir, 'inputs-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp2',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'inputs-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP2 引用复核门：真实 revision（I1–I4）· 状态闸（I4b）· 失败关闭（I7/I9）· '
      + '身份隔离（I6/I6b）· 遗忘通路（I5/I8）· Belief 投影版本与 epistemic 档位（I10–I12）· '
      + '批量去重（I13）· 同轮 overlay（I14）· 计数守恒（I15）· fixture 无写入（I17/I18）',
    databaseScope: 'isolated',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  /*
   * ⚠️ **必须显式 exit**，不能只设 `exitCode`。
   *
   * WP2 第一版实测：`main()` 在 `createM4Harness` **之后**、`try` **之前**抛错时，
   * 运行时的上游定时器仍然活着 ⇒ 进程**不退**。现象是"门挂了 >10 分钟、stdout 全空、
   * 进程 CPU 近乎 0"——一个**阻塞**而不是空转的挂死，且没有任何读数可看。
   * 一个会挂死的门比一个会失败的门更坏：它把"绿"变成"等不到结论"。
   *
   * 这里只强退**失败**路径（没有证据要落盘）；成功路径走 `h.stop()` 后自然退出，
   * 若那时仍不退，那是必须被看见的缺陷，不该被 `process.exit` 掩盖。
   */
  process.exit(1)
})
