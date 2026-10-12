/**
 * M9 独立 oracle —— 信念状态机的**预期**折叠（ADR-070 §4.2）。
 *
 * ============================================================================
 *  为什么要有它（WP2 任务 6：冻结预期状态机的独立 oracle）
 * ============================================================================
 * 「不能 import 被测 reducer 再拿自身结果当 expected」——否则测试是同义反复：
 * 生产代码错了，测试跟着错，读数永远绿。因此本文件**从 ADR-070 §4.2 的
 * 状态转换表逐条手写**，与生产实现（WP4 的 `src/kernel/projections/belief.ts`）
 * **零共享代码**；WP4 起的测试把同一批事件序列分别喂给两者，逐字段比对。
 *
 * 独立性是**机器可判**的：`scripts/m9-test.ts` 静态断言本文件源码不含
 * `projections` import（见该脚本的「静态边界」组）。
 *
 * 折叠规则（全部来自 ADR-070 §4.2 状态转换表 + §5.4 遗忘契约）：
 *   ORIGIN            首个建档生效；重复 ORIGIN 忽略（一角色一次）
 *   FORMED            新 beliefId → active；同 id 重放 = no-op（幂等）
 *   REINFORCED        仅 active 接受；新根**去重后**才计入（INV-M9-08：
 *                     同一输入重复处理不增加支持）；非 active = no-op
 *   DISPUTED          active → disputed；再 disputed = no-op（已记录）
 *   SUPERSEDED        old → superseded（终态：后续事件一律 no-op）；
 *                     new 保持其自身状态（通常 active）
 *   RETRACTED         → retracted（终态：重放旧证据不复活，B28）；
 *                     forbiddenRoots 按 slot 累积（§5.4：同槽位新提案
 *                     根集合与之相交 ⇒ 生产 Validator 必须拒绝）
 *
 * 纯函数、无 import、确定性：同一事件序列永远得到同一状态。
 */

// ---------------------------------------------------------------------------
// 事件形状（最小判别联合；测试构造，不与生产 payload 类型共享）
// ---------------------------------------------------------------------------

export type OracleBeliefEvent =
  | { kind: 'origin'; activationId: string; cutoverSequence: number }
  | {
      kind: 'formed'
      beliefId: string
      slotKey: string
      epistemicKind: 'reported' | 'inferred'
      roots: string[]
    }
  | { kind: 'reinforced'; beliefId: string; newRoots: string[] }
  | { kind: 'disputed'; beliefId: string }
  | { kind: 'superseded'; oldBeliefId: string; newBeliefId: string }
  | {
      kind: 'retracted'
      beliefId: string
      slotKey: string
      forbiddenRoots: string[]
    }

export type OracleBeliefStatus = 'active' | 'disputed' | 'superseded' | 'retracted'

export interface OracleBeliefState {
  status: OracleBeliefStatus
  /** 去重后的根事件（插入序）；supportCount = roots.length */
  roots: string[]
  epistemicKind: 'reported' | 'inferred'
}

export interface OracleFold {
  originated: boolean
  beliefs: Record<string, OracleBeliefState>
  /** slotKey → 累积的禁用根（RETRACTED 的 forbiddenRootIds 并集） */
  forbiddenRootsBySlot: Record<string, string[]>
}

// ---------------------------------------------------------------------------
// 折叠（预期状态机本体）
// ---------------------------------------------------------------------------

function mergeUnique(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing)
  const merged = [...existing]
  for (const root of incoming) {
    if (!seen.has(root)) {
      seen.add(root)
      merged.push(root)
    }
  }
  return merged
}

export function oracleFold(events: readonly OracleBeliefEvent[]): OracleFold {
  const fold: OracleFold = {
    originated: false,
    beliefs: {},
    forbiddenRootsBySlot: {},
  }

  for (const event of events) {
    switch (event.kind) {
      case 'origin': {
        // 一角色一次：首个生效，后续忽略（Validator 侧拒绝重复，oracle 只折叠）
        fold.originated = true
        break
      }
      case 'formed': {
        const existing = fold.beliefs[event.beliefId]
        if (existing) {
          // 同 id 重放 = no-op（幂等；不改状态、不并根——重放不是新证据）
          break
        }
        fold.beliefs[event.beliefId] = {
          status: 'active',
          roots: mergeUnique([], event.roots),
          epistemicKind: event.epistemicKind,
        }
        break
      }
      case 'reinforced': {
        const belief = fold.beliefs[event.beliefId]
        if (!belief || belief.status !== 'active') {
          // 不存在（孤儿）或非 active：no-op（disputed/superseded/retracted 不加支持）
          break
        }
        belief.roots = mergeUnique(belief.roots, event.newRoots)
        break
      }
      case 'disputed': {
        const belief = fold.beliefs[event.beliefId]
        if (!belief || belief.status !== 'active') {
          break // 只有 active 能进入 disputed；已 disputed = no-op
        }
        belief.status = 'disputed'
        break
      }
      case 'superseded': {
        const oldBelief = fold.beliefs[event.oldBeliefId]
        if (oldBelief && oldBelief.status !== 'superseded' && oldBelief.status !== 'retracted') {
          oldBelief.status = 'superseded'
        }
        // newBeliefId 的状态由它自己的 FORMED/后续事件决定，这里不越权改写
        break
      }
      case 'retracted': {
        const belief = fold.beliefs[event.beliefId]
        if (belief) {
          belief.status = 'retracted' // 终态：后续 REINFORCED/DISPUTED 一律 no-op
        }
        fold.forbiddenRootsBySlot[event.slotKey] = mergeUnique(
          fold.forbiddenRootsBySlot[event.slotKey] ?? [],
          event.forbiddenRoots,
        )
        break
      }
    }
  }

  return fold
}

// ---------------------------------------------------------------------------
// 遗忘契约判据（§5.4：供测试断言"生产 Validator 拒绝相交提案"）
// ---------------------------------------------------------------------------

/** 新提案的根集合是否与本槽位已禁用的根相交（相交 ⇒ 生产侧必须拒绝） */
export function oracleRootsForbidden(
  fold: OracleFold,
  slotKey: string,
  proposedRoots: readonly string[],
): boolean {
  const forbidden = fold.forbiddenRootsBySlot[slotKey]
  if (!forbidden || forbidden.length === 0) return false
  const forbiddenSet = new Set(forbidden)
  return proposedRoots.some((root) => forbiddenSet.has(root))
}

/** 同槽位重开是否构成**新**身份（新 beliefId + 不相交根集合 ⇒ 合法重开） */
export function oracleReopenIsLegal(
  fold: OracleFold,
  slotKey: string,
  newBeliefId: string,
  proposedRoots: readonly string[],
): boolean {
  return (
    fold.beliefs[newBeliefId] !== undefined &&
    !oracleRootsForbidden(fold, slotKey, proposedRoots)
  )
}
