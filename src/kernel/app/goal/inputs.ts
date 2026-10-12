/**
 * M10 WP2 —— **Goal 的真实来源引用与只读输入**（ADR-076 `D25` / §4.6）。
 *
 * ============================================================================
 *  这个文件补的是 M9.5 交给 M10 的两个缺口（WP0 基线报告 §3 的 Q1）
 * ============================================================================
 * ```text
 * 缺口 ①  `referencesFromOutcome()` 把 `sourceRevision` 固定为 1
 *         ⇒ 这里 `captureMemoryReference()` 从**当前记录**读真实 revision。
 * 缺口 ②  `recheckReferences()` 只调用消费者传入的回调，自身不查库
 *         ⇒ 这里 `recheckGoalDependencies()` **自己**批量回查、比版本、
 *            查撤销集、给具名原因；`stillValid()` 式回调**不是**复核。
 * ```
 * ⚠️ 那两个 fixture **保持原样**（它们是 M9.5 §4.4 的可执行契约，且有各自的
 *    无写入判据）。生产路径走本模块 —— 缺口的修法是**新建**，不是把 fixture
 *    改写成生产权威。
 *
 * ============================================================================
 *  四条硬性质（都是判据，不是注释）
 * ============================================================================
 * ① **批量去重回查，禁止 N+1**：端口形状是 `findMemories(ids)` /
 *    `findBeliefs(ids)`（与 M9 的 `EligibilityEvidenceLookup.findEvents(ids)` 同形），
 *    因此"逐条读"在**类型上**就写不出来。
 * ② **失败关闭**：任一端口抛错 ⇒ **全体** `unavailable`。读不到既不是
 *    `usable`，也不是 `root_missing`（"不知道"与"没有"是两件事）。
 * ③ **同轮遮蔽独立于写侧**：`applyGoalInvalidationOverlay()` 是纯函数，
 *    写侧收敛失败/未跑时它照样把本轮刚失效的依赖挡在外面（M9 §5.3 的双保险）。
 * ④ **必要前提 vs 可选背景在类型上分开**：`ReferenceUsability.as` 见
 *    `contracts/goal-reference.ts`；本文件负责**判定**，不负责**分类**
 *    （依赖类别的处置在 WP5）。
 *
 * ⚠️ 本文件是 `kernel/app/` 的**端口形状 + 纯编排**：不 import SQL / 框架 /
 *    `node:*`。真正的读落在 `infrastructure/persistence/goal-input-store.ts`。
 */

import type { WithdrawnSetResult } from '../../contracts/withdrawn-evidence.ts'
import {
  beliefUsability,
  dependencyKeyOf,
  memoryStatusUsability,
  REFERENCE_REJECTION_REASONS,
  unusable,
  usable,
  type BeliefReference,
  type GoalDependencyRef,
  type MemoryReference,
  type ReferenceRejectionReason,
  type ReferenceUsability,
} from '../../contracts/goal-reference.ts'

// ---------------------------------------------------------------------------
// 端口形状（只给形状；实现见 infrastructure）
// ---------------------------------------------------------------------------

/**
 * 一条 Memory 的**当前读数**（按 ID 读出的最小视图）。
 *
 * ⚠️ `revision` 必须是**记录的真实版本**（`memory-store.ts` 的行映射读它）；
 *    写死 / 缓存快照都会让缺口 ① 重新出现。
 */
export interface GoalMemoryReading {
  readonly id: string
  readonly ownerKind: string
  readonly ownerId: string
  /** `entityLabel` 形状的 subject 键（`kind:id`） */
  readonly subjectKeys: readonly string[]
  readonly status: string
  readonly revision: number
  /** 支撑该记录的根证据 id（遗忘遮蔽判定的输入） */
  readonly evidenceIds: readonly string[]
}

/** 一条 Belief 的**当前读数**（按 ID 读出的最小视图） */
export interface GoalBeliefReading {
  readonly beliefId: string
  /** 投影**行**的 revision（不是 state 里的字段） */
  readonly projectionRevision: number
  readonly perspectiveOwnerId: string
  readonly subjectKind: string
  readonly subjectId: string
  readonly status: string
  readonly epistemicKind: string
  readonly supportLevel: string
  readonly evidenceRootIds: readonly string[]
  readonly dependsOnMemoryIds: readonly string[]
}

/**
 * Memory 回查端口。
 *
 * ⚠️ **批量**形状是判据的一部分（性质 ①）：`ids` 里没有的 id 不需要出现在返回值里，
 *    调用方按缺失判 `root_missing`。
 */
export interface GoalMemoryLookup {
  findMemories(ids: readonly string[]): Promise<readonly GoalMemoryReading[]>
}

/** Belief 回查端口（同样是批量形状） */
export interface GoalBeliefLookup {
  findBeliefs(ids: readonly string[]): Promise<readonly GoalBeliefReading[]>
}

/**
 * 撤销集端口（M9.1 `D16`）。
 *
 * 复用 `WithdrawnSetResult` **逐字**（含 `ok` / `gaps` / `measuredCount`）——
 * 不新增第二种"哪些证据不许用了"的表示。
 */
export interface GoalWithdrawnLookup {
  compute(): Promise<WithdrawnSetResult>
}

export interface GoalInputPorts {
  readonly memory: GoalMemoryLookup
  readonly belief: GoalBeliefLookup
  readonly withdrawn: GoalWithdrawnLookup
  readonly policy: {
    /** 生产单 Character（ADR-076 `D04`） */
    readonly characterId: string
    /** 当前活动用户（跨用户泄漏的判据） */
    readonly activeUserId: string
  }
}

/** 捕获结论（失败关闭；`reason` 用同一套闭集） */
export type CaptureOutcome<T> =
  | { readonly captured: true; readonly reference: T }
  | { readonly captured: false; readonly reason: ReferenceRejectionReason }

// ---------------------------------------------------------------------------
// 身份隔离（§4.6 的 owner / target 复核项）
// ---------------------------------------------------------------------------

/** `kind:id` 的第一段是 kind（id 自身可能含 ':'，因此只切第一个冒号） */
function splitEntityKey(key: string): { kind: string; id: string } {
  const at = key.indexOf(':')
  if (at < 0) return { kind: '', id: key }
  return { kind: key.slice(0, at), id: key.slice(at + 1) }
}

/**
 * 身份隔离判定：**owner 必须是本角色；subject 不得含其他 user**。
 *
 * 为什么"其他 user"必须拒：Goal 的规划背景若建立在**另一个用户**的数据上，
 * 那就是跨用户泄漏 —— 而 ADR-076 `D04` 的"生产仍单 Character"不等于
 * "可以读别人的行"。本角色自己（`character:*`）作 subject 是允许的
 * （"我们曾经讨论过…"那类记忆天然有两个主体）。
 */
function identityRejection(input: {
  ownerKind: string
  ownerId: string
  subjectKeys: readonly string[]
  policy: GoalInputPorts['policy']
}): ReferenceRejectionReason | undefined {
  if (input.ownerKind !== 'character' || input.ownerId !== input.policy.characterId) {
    return 'foreign'
  }
  for (const key of input.subjectKeys) {
    const { kind, id } = splitEntityKey(key)
    if (kind === 'user' && id !== input.policy.activeUserId) return 'foreign'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 捕获（真实 revision / 投影版本）
// ---------------------------------------------------------------------------

/**
 * 捕获一条 Memory 引用（**真实 revision**）。
 *
 * 失败关闭：读端口抛错 ⇒ `{ captured: false, reason: 'unavailable' }`。
 */
export async function captureMemoryReference(
  ports: GoalInputPorts,
  memoryId: string,
): Promise<CaptureOutcome<MemoryReference>> {
  let findings: readonly GoalMemoryReading[]
  try {
    findings = await ports.memory.findMemories([memoryId])
  } catch {
    return { captured: false, reason: 'unavailable' }
  }
  const reading = findings.find((row) => row.id === memoryId)
  if (reading === undefined) return { captured: false, reason: 'root_missing' }
  const identity = identityRejection({ ...reading, policy: ports.policy })
  if (identity !== undefined) return { captured: false, reason: identity }
  return {
    captured: true,
    reference: {
      memoryId,
      sourceRevision: reading.revision,
      evidenceIds: [...reading.evidenceIds],
    },
  }
}

/** 捕获一条 Belief 引用（**投影行版本 + epistemic 标签随行**） */
export async function captureBeliefReference(
  ports: GoalInputPorts,
  beliefId: string,
): Promise<CaptureOutcome<BeliefReference>> {
  let findings: readonly GoalBeliefReading[]
  try {
    findings = await ports.belief.findBeliefs([beliefId])
  } catch {
    return { captured: false, reason: 'unavailable' }
  }
  const reading = findings.find((row) => row.beliefId === beliefId)
  if (reading === undefined) return { captured: false, reason: 'root_missing' }
  const identity = identityRejection({
    ownerKind: 'character',
    ownerId: reading.perspectiveOwnerId,
    subjectKeys: [`${reading.subjectKind}:${reading.subjectId}`],
    policy: ports.policy,
  })
  if (identity !== undefined) return { captured: false, reason: identity }
  return {
    captured: true,
    reference: {
      beliefId,
      projectionRevision: reading.projectionRevision,
      epistemicKind: reading.epistemicKind as BeliefReference['epistemicKind'],
      supportLevel: reading.supportLevel as BeliefReference['supportLevel'],
      status: reading.status as BeliefReference['status'],
      evidenceRootIds: [...reading.evidenceRootIds],
      dependsOnMemoryIds: [...reading.dependsOnMemoryIds],
    },
  }
}

// ---------------------------------------------------------------------------
// 使用前复核（批量 · 去重 · 失败关闭）
// ---------------------------------------------------------------------------

export interface GoalDependencyRecheckCounts {
  /** 去重后的依赖条数（**分母**） */
  readonly total: number
  readonly hard: number
  readonly soft: number
  readonly rejected: number
  /** 每个原因命中的条数（**0 也要出现**：缺键会让"没查"与"没命中"混同） */
  readonly byReason: Readonly<Record<ReferenceRejectionReason, number>>
  /** 撤销集的读数（原样带出，供 trace 与失败关闭分级） */
  readonly withdrawn: {
    readonly ok: boolean
    readonly measuredCount: number
    readonly gapCount: number
    readonly gaps: readonly string[]
  }
}

export interface GoalDependencyRecheckReport {
  /** key = `dependencyKeyOf(dep)` */
  readonly verdicts: ReadonlyMap<string, ReferenceUsability>
  readonly counts: GoalDependencyRecheckCounts
  /**
   * 本次**真的读了几条**记录（`measured_count` 自检的输入）。
   *
   * 0 ⇒ 调用方必须判 `MEASUREMENT INVALID`，**不是** PASS（AGENTS §6.8）。
   */
  readonly measuredCount: number
}

export interface RecheckGoalDependenciesOptions {
  /**
   * 依赖 id → 捕获时的引用。**可选**：
   *   · 传了 ⇒ 走"版本比对"（旧引用会得 `revision_changed`）
   *   · 没传 ⇒ 只判"当前能不能用"（不判"这个指针是不是旧快照"）
   */
  readonly memoryReferences?: ReadonlyMap<string, MemoryReference>
  readonly beliefReferences?: ReadonlyMap<string, BeliefReference>
}

function zeroReasonCounts(): Record<ReferenceRejectionReason, number> {
  const out = {} as Record<ReferenceRejectionReason, number>
  for (const reason of REFERENCE_REJECTION_REASONS) out[reason] = 0
  return out
}

/**
 * 对一组 Goal 依赖做**一次**批量回查。
 *
 * 判定优先级（与 `REFERENCE_REJECTION_REASONS` 的顺序一致）：
 * `unavailable` → `root_missing` → `foreign` → `forgotten` →
 * `withdrawn_incomplete` → `revision_changed` → `status_not_usable`。
 * （`overlaid` 不在这里 —— 它是**本轮 overlay**，见下面的纯函数。）
 *
 * ⚠️ 任一端口抛错 ⇒ **全体** `unavailable`：读不到证据 = 不能用，
 *    不是"大概没事"。这与 M9 的 `recheckBeliefDependencies` 同一条纪律。
 */
export async function recheckGoalDependencies(
  ports: GoalInputPorts,
  deps: readonly GoalDependencyRef[],
  options: RecheckGoalDependenciesOptions = {},
): Promise<GoalDependencyRecheckReport> {
  const verdicts = new Map<string, ReferenceUsability>()
  const byReason = zeroReasonCounts()
  const memoryIds = new Set<string>()
  const beliefIds = new Set<string>()
  for (const dep of deps) {
    if (dep.kind === 'memory') memoryIds.add(dep.memoryId)
    else beliefIds.add(dep.beliefId)
  }
  const deduped: GoalDependencyRef[] = [
    ...[...memoryIds].sort().map((memoryId) => ({ kind: 'memory', memoryId }) as const),
    ...[...beliefIds].sort().map((beliefId) => ({ kind: 'belief', beliefId }) as const),
  ]

  const rejectAll = (reason: ReferenceRejectionReason): GoalDependencyRecheckReport => {
    for (const dep of deduped) {
      verdicts.set(dependencyKeyOf(dep), unusable(reason))
      byReason[reason] += 1
    }
    return {
      verdicts,
      counts: {
        total: deduped.length,
        hard: 0,
        soft: 0,
        rejected: deduped.length,
        byReason,
        withdrawn: { ok: false, measuredCount: 0, gapCount: 0, gaps: [] },
      },
      measuredCount: 0,
    }
  }

  if (deduped.length === 0) {
    return {
      verdicts,
      counts: {
        total: 0,
        hard: 0,
        soft: 0,
        rejected: 0,
        byReason,
        withdrawn: { ok: false, measuredCount: 0, gapCount: 0, gaps: [] },
      },
      measuredCount: 0,
    }
  }

  let memories: readonly GoalMemoryReading[] = []
  let beliefs: readonly GoalBeliefReading[] = []
  let withdrawn: WithdrawnSetResult
  try {
    withdrawn = await ports.withdrawn.compute()
    if (memoryIds.size > 0) memories = await ports.memory.findMemories([...memoryIds])
    if (beliefIds.size > 0) beliefs = await ports.belief.findBeliefs([...beliefIds])
  } catch {
    return rejectAll('unavailable')
  }

  const memoryById = new Map(memories.map((row) => [row.id, row]))
  const beliefById = new Map(beliefs.map((row) => [row.beliefId, row]))
  const withdrawnIds = new Set(withdrawn.withdrawnEventIds)

  const tally = { hard: 0, soft: 0, rejected: 0 }
  const set = (dep: GoalDependencyRef, verdict: ReferenceUsability): void => {
    verdicts.set(dependencyKeyOf(dep), verdict)
    if (verdict.usable) {
      if (verdict.as === 'hard') tally.hard += 1
      else tally.soft += 1
    } else {
      tally.rejected += 1
      byReason[verdict.reason] += 1
    }
  }

  for (const dep of deduped) {
    if (dep.kind === 'memory') {
      const reading = memoryById.get(dep.memoryId)
      if (reading === undefined) {
        set(dep, unusable('root_missing'))
        continue
      }
      const identity = identityRejection({ ...reading, policy: ports.policy })
      if (identity !== undefined) {
        set(dep, unusable(identity))
        continue
      }
      if (reading.evidenceIds.some((id) => withdrawnIds.has(id))) {
        set(dep, unusable('forgotten'))
        continue
      }
      if (!withdrawn.ok) {
        set(dep, unusable('withdrawn_incomplete'))
        continue
      }
      const reference = options.memoryReferences?.get(dep.memoryId)
      if (reference !== undefined && reference.sourceRevision !== reading.revision) {
        set(dep, unusable('revision_changed'))
        continue
      }
      const grade = memoryStatusUsability(reading.status)
      set(dep, grade === undefined ? unusable('status_not_usable') : usable(grade))
      continue
    }

    const reading = beliefById.get(dep.beliefId)
    if (reading === undefined) {
      set(dep, unusable('root_missing'))
      continue
    }
    const identity = identityRejection({
      ownerKind: 'character',
      ownerId: reading.perspectiveOwnerId,
      subjectKeys: [`${reading.subjectKind}:${reading.subjectId}`],
      policy: ports.policy,
    })
    if (identity !== undefined) {
      set(dep, unusable(identity))
      continue
    }
    if (reading.evidenceRootIds.some((id) => withdrawnIds.has(id))) {
      set(dep, unusable('forgotten'))
      continue
    }
    if (!withdrawn.ok) {
      set(dep, unusable('withdrawn_incomplete'))
      continue
    }
    const reference = options.beliefReferences?.get(dep.beliefId)
    if (reference !== undefined && reference.projectionRevision !== reading.projectionRevision) {
      set(dep, unusable('revision_changed'))
      continue
    }
    const grade = beliefUsability(
      reading.epistemicKind as BeliefReference['epistemicKind'],
      reading.status as BeliefReference['status'],
    )
    set(dep, grade === undefined ? unusable('status_not_usable') : usable(grade))
  }

  return {
    verdicts,
    counts: {
      total: deduped.length,
      hard: tally.hard,
      soft: tally.soft,
      rejected: tally.rejected,
      byReason,
      withdrawn: {
        ok: withdrawn.ok,
        measuredCount: withdrawn.measuredCount,
        gapCount: withdrawn.gaps.length,
        gaps: withdrawn.gaps,
      },
    },
    measuredCount: memories.length + beliefs.length,
  }
}

// ---------------------------------------------------------------------------
// 本轮 invalidation overlay（同轮遮蔽；纯函数）
// ---------------------------------------------------------------------------

/**
 * 本轮程序结果里**刚失效**的依赖（Memory 撤回/取代/合并 loser 的 id，
 * 以及刚降档的根事件 id）。来自 Memory 操作路径的**程序结果** —— 不是猜测。
 */
export interface GoalInvalidationOverlay {
  readonly invalidatedMemoryIds: readonly string[]
  readonly invalidatedRootIds?: readonly string[]
}

/**
 * 叠加同轮遮蔽：回查判定可用、但依赖命中本轮失效集 ⇒ `overlaid`（不可用）。
 *
 * **纯函数**——同轮快照语义，不读存储。写侧修订未完成 / 失败 / 后台任务没跑时，
 * 这一层仍然把失效内容挡在模型之外（ADR-076 §4.6 的双保险读侧半边）。
 *
 * 三条命中路径（与 M9 的 `applyInvalidationOverlay` 同形）：
 * ```text
 * Memory 依赖        dep.memoryId ∈ invalidatedMemoryIds
 * Belief 的根        reference.evidenceRootIds ∩ invalidatedRootIds ≠ ∅
 * Belief 的记忆依赖  reference.dependsOnMemoryIds ∩ invalidatedMemoryIds ≠ ∅
 * ```
 * ⚠️ 后两条要求调用方给出 `references` —— 引用里带着证据指针，
 *    因此 overlay **不需要**为了"这条信念的根刚刚失效了吗"再读一次库。
 *    没给引用 ⇒ 那两条路径**不命中**（而不是"假装检查过"）；
 *    这一点在返回值的 `counts.byReason.overlaid` 上如实体现为 0。
 *
 * ⚠️ 它**只降档、不升档**：已经是 `usable:false` 的条目保持原样
 *    （原因为 `unavailable` / `forgotten` 等更具体的读数）。
 */
export function applyGoalInvalidationOverlay(
  report: GoalDependencyRecheckReport,
  deps: readonly GoalDependencyRef[],
  overlay: GoalInvalidationOverlay,
  references: RecheckGoalDependenciesOptions = {},
): GoalDependencyRecheckReport {
  const memoryIds = new Set(overlay.invalidatedMemoryIds.map(String))
  const rootIds = new Set((overlay.invalidatedRootIds ?? []).map(String))
  const verdicts = new Map(report.verdicts)
  const byReason = { ...report.counts.byReason }
  let hard = report.counts.hard
  let soft = report.counts.soft
  let rejected = report.counts.rejected

  for (const dep of deps) {
    const key = dependencyKeyOf(dep)
    const current = verdicts.get(key)
    if (current === undefined || !current.usable) continue

    let hit = dep.kind === 'memory' && memoryIds.has(dep.memoryId)
    if (!hit && dep.kind === 'belief') {
      const reference = references.beliefReferences?.get(dep.beliefId)
      if (reference !== undefined) {
        hit =
          reference.evidenceRootIds.some((id) => rootIds.has(id)) ||
          reference.dependsOnMemoryIds.some((id) => memoryIds.has(id))
      }
    }
    if (!hit) continue

    if (current.as === 'hard') hard -= 1
    else soft -= 1
    rejected += 1
    byReason.overlaid += 1
    verdicts.set(key, unusable('overlaid'))
  }

  return {
    verdicts,
    counts: { ...report.counts, hard, soft, rejected, byReason },
    measuredCount: report.measuredCount,
  }
}
