/**
 * Belief 读侧资格回查 + 本轮 invalidation overlay（M9 WP5 / ADR-070 §5.1–§5.3）。
 *
 * ============================================================================
 *  这是"双保险"的读侧半边（零泄漏不依赖写侧成功）
 * ============================================================================
 * 写侧（revision.ts）追加撤回/取代事件**最终收敛**；读侧在这里**立即遮蔽**：
 * 即使修订任务失败/未跑完，已失效的内容也进不了模型上下文。
 *
 * ---------------------------------------------------------------------------
 *  回查纪律（§5.2，逐条冻结）
 * ---------------------------------------------------------------------------
 * · 按**确切 ID**回查（evidenceRootIds / dependsOnMemoryIds），批量去重读取
 *   （不逐条 N+1）；**禁止**用 Recall 排名/top-k 判断依赖是否存在——
 *   旧来源掉出候选 ≠ 不存在。
 * · 扫描未完成 / 存储错误 ⇒ `unavailable`，**当失效处理**（失败关闭），
 *   不得当 valid，也不得当"不存在"。
 * · inferred 根：资格四条（contracts 单源 `beliefEvidenceQualifies`）；
 *   reported 根：存在性 + Memory 白名单资格（`isBeliefReportedEligible`），
 *   不施切换后条件（历史陈述）。
 *
 * ---------------------------------------------------------------------------
 *  同轮顺序（§5.3）
 * ---------------------------------------------------------------------------
 * 当前输入先走 Memory 操作路径取得**程序结果**；Context snapshot 在该结果
 * 之后决定可用 Belief。本轮刚失效的 Memory id（程序结果）进 overlay ⇒
 * 依赖它的信念**同轮**排除——不可"本轮照说旧内容，下轮再修"。
 */
import {
  beliefEvidenceQualifies,
  isBeliefReportedEligible,
  type BeliefEvidencePolicy,
  type BeliefOriginState,
  type BeliefState,
} from '../../contracts/belief.ts'
import type { MemoryId } from '../../contracts/ids.ts'

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 证据回查（与 validator 的 BeliefEvidenceLookup 同一形状——装配层可同源） */
export interface EligibilityEvidenceLookup {
  findEvents(
    ids: readonly string[],
  ): Promise<
    {
      id: string
      characterId: string
      sequence: number
      type: string
      actorId?: string
      conversationId?: string
      trustedOrigin?: unknown
    }[]
  >
}

/** Memory 回查（当前状态视图；与 validator 的 BeliefMemoryLookup 同源） */
export interface EligibilityMemoryLookup {
  findMemories(
    ids: readonly MemoryId[],
  ): Promise<
    {
      id: MemoryId
      ownerId: string
      type: string
      authority: string
      epistemicStatus: string
      status: string
    }[]
  >
}

export interface BeliefEligibilityDeps {
  characterId: string
  evidence: EligibilityEvidenceLookup
  memory: EligibilityMemoryLookup
  /** 建档行（cutover——inferred 根的资格四条之一） */
  origin: { getBeliefOrigin(characterId: string): Promise<BeliefOriginState | undefined> }
  policy: { activeUserId: string }
}

/** 单条信念的回查判定（usable=false 一律带 reason，可审计） */
export interface BeliefUsabilityVerdict {
  beliefId: string
  usable: boolean
  reason:
    | 'ok'
    | 'root_missing'
    | 'root_unqualified'
    | 'root_foreign'
    | 'memory_missing'
    | 'memory_not_qualified'
    | 'memory_foreign'
    | 'unavailable'
    | 'overlaid'
}

// ---------------------------------------------------------------------------
// 批量回查（§5.2：确切 ID · 去重批量 · 失败关闭）
// ---------------------------------------------------------------------------

/**
 * 对候选信念集合做**一次**批量回查。
 *
 * 返回 beliefId → 判定。任何查找抛错 ⇒ 全体 `unavailable`（失败关闭：
 * 读不到证据 = 不能用，不是"大概没事"）。
 */
export async function recheckBeliefDependencies(
  deps: BeliefEligibilityDeps,
  beliefs: readonly BeliefState[],
): Promise<Map<string, BeliefUsabilityVerdict>> {
  const verdicts = new Map<string, BeliefUsabilityVerdict>()
  if (beliefs.length === 0) return verdicts

  // 去重收集全部依赖 ID（批量读，防 N+1）
  const rootIds = new Set<string>()
  const memoryIds = new Set<string>()
  for (const belief of beliefs) {
    for (const id of belief.evidenceRootIds ?? []) rootIds.add(String(id))
    for (const id of belief.dependsOnMemoryIds ?? []) memoryIds.add(String(id))
  }

  let events: Awaited<ReturnType<EligibilityEvidenceLookup['findEvents']>> = []
  let memories: Awaited<ReturnType<EligibilityMemoryLookup['findMemories']>> = []
  try {
    if (rootIds.size > 0) events = await deps.evidence.findEvents([...rootIds])
    if (memoryIds.size > 0) memories = await deps.memory.findMemories([...memoryIds] as MemoryId[])
  } catch {
    for (const belief of beliefs) {
      verdicts.set(String(belief.beliefId), {
        beliefId: String(belief.beliefId),
        usable: false,
        reason: 'unavailable',
      })
    }
    return verdicts
  }

  const eventById = new Map(events.map((e) => [String(e.id), e]))
  const memoryById = new Map(memories.map((m) => [String(m.id), m]))
  const origin = await deps.origin.getBeliefOrigin(deps.characterId)
  // 未建档 ⇒ null ⇒ 资格四条拒绝一切 inferred 根（失败关闭，与放行口同口径）
  const cutoverSequence: number | null = origin?.cutoverSequence ?? null

  for (const belief of beliefs) {
    const id = String(belief.beliefId)
    // —— 根回查 ——
    for (const rootId of belief.evidenceRootIds ?? []) {
      const event = eventById.get(String(rootId))
      if (event === undefined) {
        verdicts.set(id, { beliefId: id, usable: false, reason: 'root_missing' })
        break
      }
      if (String(event.characterId) !== String(deps.characterId)) {
        verdicts.set(id, { beliefId: id, usable: false, reason: 'root_foreign' })
        break
      }
      if (belief.epistemicKind === 'inferred') {
        // 资格四条（contracts 单源；cutover 来自建档行，未建档 = 拒绝一切）
        const qualified = beliefEvidenceQualifies(
          {
            id: event.id as never,
            sequence: event.sequence,
            type: event.type,
            actorId: event.actorId,
            trustedOrigin: event.trustedOrigin as never,
          },
          { activeUserId: deps.policy.activeUserId, cutoverSequence },
        )
        if (!qualified) {
          verdicts.set(id, { beliefId: id, usable: false, reason: 'root_unqualified' })
          break
        }
      }
    }
    if (verdicts.has(id)) continue
    // —— Memory 依赖回查（reported）——
    for (const memoryId of belief.dependsOnMemoryIds ?? []) {
      const memory = memoryById.get(String(memoryId))
      if (memory === undefined) {
        verdicts.set(id, { beliefId: id, usable: false, reason: 'memory_missing' })
        break
      }
      if (String(memory.ownerId) !== String(deps.characterId)) {
        verdicts.set(id, { beliefId: id, usable: false, reason: 'memory_foreign' })
        break
      }
      if (!isBeliefReportedEligible(memory as never)) {
        verdicts.set(id, { beliefId: id, usable: false, reason: 'memory_not_qualified' })
        break
      }
    }
    if (verdicts.has(id)) continue
    verdicts.set(id, { beliefId: id, usable: true, reason: 'ok' })
  }
  return verdicts
}

// ---------------------------------------------------------------------------
// 本轮 invalidation overlay（§5.3：同轮遮蔽，先于写侧收敛）
// ---------------------------------------------------------------------------

/**
 * 本轮程序结果里**刚失效**的依赖（Memory 撤回/取代/合并 loser 的 id）。
 * 来自 Memory 操作路径的程序结果——不是 Belief 自己的猜测。
 */
export interface InvalidationOverlayInput {
  /** 本轮刚失效的 Memory id */
  invalidatedMemoryIds: readonly string[]
  /** 本轮刚失效（qualified→unqualified）的根事件 id */
  invalidatedRootIds?: readonly string[]
}

/**
 * 叠加同轮遮蔽：回查判定 ok、但依赖命中本轮失效集 ⇒ `overlaid`（不可用）。
 *
 * 纯函数——同轮快照语义，不读存储。写侧修订未完成/失败时，这一层
 * 仍然把失效内容挡在模型之外（§7.1 双保险的读侧承诺）。
 */
export function applyInvalidationOverlay(
  verdicts: ReadonlyMap<string, BeliefUsabilityVerdict>,
  beliefs: readonly BeliefState[],
  overlay: InvalidationOverlayInput,
): Map<string, BeliefUsabilityVerdict> {
  const memories = new Set(overlay.invalidatedMemoryIds.map(String))
  const roots = new Set((overlay.invalidatedRootIds ?? []).map(String))
  const out = new Map(verdicts)
  for (const belief of beliefs) {
    const id = String(belief.beliefId)
    const current = out.get(id)
    if (current === undefined || !current.usable) continue
    const memoryHit = (belief.dependsOnMemoryIds ?? []).some((m) => memories.has(String(m)))
    const rootHit = (belief.evidenceRootIds ?? []).some((r) => roots.has(String(r)))
    if (memoryHit || rootHit) {
      out.set(id, { beliefId: id, usable: false, reason: 'overlaid' })
    }
  }
  return out
}

/** 便捷：usable 集合（Context 组装的输入；只收 usable=true） */
export function usableBeliefsOf(
  verdicts: ReadonlyMap<string, BeliefUsabilityVerdict>,
): string[] {
  const out: string[] = []
  for (const [id, verdict] of verdicts) {
    if (verdict.usable) out.push(id)
  }
  return out
}
