/**
 * EBL → 协作契约的**快照适配器**（2026-10-21 · 计划 P1 续 / P2 第一步）
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  P1 落了**形状与判据**（`src/kernel/contracts/cognitive-collaboration.ts`），
 *  但那份形状当时验的是**夹具**。本文件把**真实的 EBL 状态**接上去：
 *
 *    EBL 存储（证据资格 · 政策 · 独立根 · 状态）
 *      └─ `createEblStore(...).snapshot(claimId)`  ← 只读，不写
 *           └─ **本适配器** → `UsableRuleSnapshot`（契约形状）
 *                └─ 规则消费者 / 提交口 / 执行前复核（纯判据）
 *
 * ============================================================================
 *  三条不许破的边界（这里是它们落地的地方）
 * ============================================================================
 * ① **不重算证据资格**：合格与否由 EBL 的 `eblUsable` 判（**它**知道政策与独立根）。
 *    本文件只做**形状映射** ⇒ 不会出现"两套实现算出两个答案"。
 * ② **不写权威状态**：本文件只读（`snapshot()` 不开事务、不写）。
 *    ⇒ "候选不能直接写权威状态"在**机制面**上成立。
 * ③ **不新建状态机**：`status` 是 EBL 的状态字符串（**引用**），
 *    失效原因只是**映射**出来的闭集值（不新增 EBL 状态）。
 *
 * ⚠️ 领域方向：契约层（kernel/contracts）**不认识** EBL；本文件（infrastructure）
 *    是**唯一**知道两边形状的地方 ⇒ 领域之间不成环。
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import {
  type RuleInvalidationReason,
  type RuleSnapshotPort,
  type UsableRuleSnapshot,
} from '../../kernel/contracts/cognitive-collaboration.ts'
import { eblUsable } from '../../kernel/app/epistemic-belief-lifecycle/lifecycle.ts'
import { createEblStore } from '../persistence/epistemic-belief-store.ts'
import { createEblSourceReader, type EblSourceReaderOptions } from '../persistence/epistemic-belief-source.ts'
import { listProjections } from '../persistence/event-store.ts'
import type { RawDb } from '../persistence/db.ts'

/**
 * EBL 状态 → 失效原因（**闭集映射**；不新增 EBL 状态）。
 *
 * ⚠️ `withdrawn` 是唯一有专门含义的：来源被撤回 ⇒ 根被禁 ⇒ 不可再用。
 *    其余不可用状态一律 `not_usable`（**不细分**：细分就要在两边各建一套语义）。
 */
function invalidatedReasonOf (status: string): RuleInvalidationReason {
  return status === 'withdrawn' ? 'source_withdrawn' : 'not_usable'
}

/**
 * 建一个**只读**的规则快照读面。
 *
 * @param db            仓储句柄
 * @param characterId   角色（EBL 的投影按角色隔离）
 * @param activeUserId  当前用户（来源读面按用户读）
 */
export function createEblRuleSnapshotPort (
  db: RawDb,
  characterId: CharacterId,
  activeUserId: string,
  sourceOptions: EblSourceReaderOptions = {}
): RuleSnapshotPort {
  const store = createEblStore(db, characterId, createEblSourceReader(activeUserId, sourceOptions))
  /**
   * 列出**当前**的全部命题。
   *
   * ⚠️ 枚举的是**投影行**（`ebl:<claimId>`），不是"表里所有行"——
   *    规则消费者要的是"**当前**的命题"，而 EBL 的当前态就在投影里。
   *    ⇒ 顺带满足计划 §3 P2 的「避免全库检索结果直接变成可用规则」。
   */
  async function list (): Promise<UsableRuleSnapshot[]> {
    const projections = await listProjections(db, characterId)
    const claimIds = projections
      .filter(projection => projection.projectionType.startsWith('ebl:'))
      .map(projection => projection.projectionType.slice('ebl:'.length))
      .sort()
    const snapshots: UsableRuleSnapshot[] = []
    for (const claimId of claimIds) {
      const snapshot = await port.current(claimId)
      if (snapshot !== undefined) snapshots.push(snapshot)
    }
    return snapshots
  }
  const port: RuleSnapshotPort = {
    list,
    async current (claimId: string): Promise<UsableRuleSnapshot | undefined> {
      const snapshot = await store.snapshot(claimId)
      if (snapshot === undefined) return undefined
      const { state, revision, sourcesFingerprint, sourceSet } = snapshot
      const claim = state.claim
      /*
       * ⚠️ "合格"用的是**命题自己的口径**（它自己的主体/范围/环境/条件）——
       *    "能不能在**这里**消费"是消费方的事（契约里的 `subject_mismatch` 判据）。
       *    ⇒ 两者不混：一个说"它本身合格吗"，一个说"它合格**且**适用于我"。
       *
       * ⚠️ `sourceSet` 来自**同一条读面**（store 的 `sourcesOf`）⇒
       *    判政策用的来源与指纹用的来源**必然是同一份**（不会分叉）。
       */
      const ownContext = {
        subjectId: claim.subjectId,
        scope: claim.scope,
        environment: claim.environment,
        conditions: claim.conditions,
      }
      const usable = eblUsable(state, sourceSet, ownContext, true)
      return {
        claimId: claim.id,
        predicate: claim.predicate,
        expected: claim.expected,
        claimVersion: revision,
        policy: claim.policy,
        subjectId: claim.subjectId,
        scope: claim.scope,
        environment: claim.environment,
        conditions: claim.conditions,
        /*
         * ⚠️ **规则版本 = 命题 id**：EBL 的命题 id 是**内容寻址**的
         *    （`ebl:<fnv1a64Hex(signature)>`，signature 含主体/谓词/取值/范围/环境/条件/政策）
         *    ⇒ 同一个 id 就是**同一条规则**；id 变了就是规则内容变了。
         *    （`src/kernel/contracts/epistemic-belief.ts` 的 `makeEblClaim` / `eblSignature`）
         */
        ruleVersion: claim.id,
        sources: sourceSet.observations.map(observation => ({
          kind: observation.ref.kind,
          id: observation.ref.id,
          revision: observation.revision,
        })),
        evidenceFingerprint: sourcesFingerprint,
        status: state.status,
        usable,
        ...(usable ? {} : { invalidatedReason: invalidatedReasonOf(state.status) }),
      }
    },
  }
  return port
}
