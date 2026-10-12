/**
 * M10 WP2 —— **Goal 输入的只读适配器**（ADR-076 `D25` / §4.6）。
 *
 * ============================================================================
 *  它是谁的薄适配器
 * ============================================================================
 * 语义与判定在 `kernel/app/goal/inputs.ts`（端口 + 纯编排）与
 * `kernel/contracts/goal-reference.ts`（契约）。本文件只做**读**：
 *
 * ```text
 * GoalMemoryLookup   ← createNativeMemoryStore(db).get(id)      （**唯一**的行映射）
 * GoalBeliefLookup   ← getBelief(db, characterId, beliefId)      （**投影行**，带 revision）
 * GoalWithdrawnLookup← computeWithdrawnEvidence(db, store, owner)（M9.1 D16 端口，原样复用）
 * ```
 *
 * ⚠️ **不新增第二个行映射器**（`qualification-read.ts` 文件头登记过同一个教训：
 *    第二个适配边界会漂移，而漂移的表现是"召回说这条已确立、探针说它没确立"）。
 *    因此 Memory 读数经 `MemoryStorePort.get()` 拿 canonical `MemoryRecord`，
 *    而不是在这里 `select * from memory_records` 再拼一遍字段。
 *
 * ============================================================================
 *  两处**如实登记**的边界（都不是沉默的取舍）
 * ============================================================================
 * ① **批量形状的端口，逐 ID 解析的实现**。
 *    契约要求"批量去重回查、禁止 N+1"（`inputs.ts` 性质 ①），而现有
 *    `MemoryStorePort` **没有**按 id 集合读的方法（`MemoryQueryScope` 只有
 *    owner / status / type / limit；`rowToRecordBase` 是模块私有）。
 *    两条路：改 M4 的冻结面（加 `getMany`），或在这里逐个 `get`。
 *    本步选后者，并且**有界**：`dependencies ≤16`（ADR-076 §4.1），
 *    即最多 16 次主键索引查找 —— 而去动 M4 的冻结面为一个 ≤16 的读，
 *    代价与收益不成比例。**具名条件**：若依赖上限被抬到 ~64 以上，
 *    必须改为真正的 `where id in (...)` 批量读（登记给 WP9 的规模门）。
 * ② **撤销集端口每次复核都重算**（`computeWithdrawnEvidence` 内部 `list` 上限 500）。
 *    不缓存是**故意的**：ADR-076 §4.6 要求"跨 async 边界之后再检查"，
 *    缓存会把"复核"退化成"读一个可能过期的快照"。代价已登记给 WP9。
 */

import type { EntityRef } from '../../kernel/contracts/entity.ts'
import { entityLabel } from '../../kernel/contracts/entity.ts'
import type { MemoryId } from '../../kernel/contracts/ids.ts'
import type { MemoryRecord } from '../../kernel/contracts/memory.ts'
import type {
  GoalBeliefLookup,
  GoalBeliefReading,
  GoalInputPorts,
  GoalMemoryLookup,
  GoalMemoryReading,
  GoalWithdrawnLookup,
} from '../../kernel/app/goal/inputs.ts'
import { getBelief } from './belief-store.ts'
import type { RawDb } from './db.ts'
import { createNativeMemoryStore, type MemoryStorePort } from './memory-store.ts'
import { computeWithdrawnEvidence } from './withdrawn-evidence.ts'

// ---------------------------------------------------------------------------
// 行 → 读数（唯一的映射点）
// ---------------------------------------------------------------------------

/**
 * `MemoryRecord` → `GoalMemoryReading`。
 *
 * `evidenceIds` 取 **roots ∪ sourceRefs**：撤销集是由**记录的 `sourceRefs`**
 * 算出来的（`withdrawnSetCore` 的输入形状），所以判"是否被遗忘"必须看 sourceRefs；
 * 把 roots 一并带上是最保守的方向（宁过遮不漏，M9.1 `D19`）。
 * id 命名空间带前缀（`cev:` / `mem:`），并集不会造成误配。
 */
function memoryReadingOf(record: MemoryRecord): GoalMemoryReading {
  const evidenceIds = new Set<string>()
  for (const id of record.evidenceRootIds) evidenceIds.add(String(id))
  for (const ref of record.sourceRefs) evidenceIds.add(String(ref.id))
  return {
    id: String(record.id),
    ownerKind: record.owner.kind,
    ownerId: String(record.owner.id),
    subjectKeys: record.subjects.map((subject) => entityLabel(subject)),
    status: record.status,
    revision: record.revision,
    evidenceIds: [...evidenceIds],
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createGoalMemoryLookup(store: MemoryStorePort): GoalMemoryLookup {
  return {
    async findMemories(ids: readonly string[]): Promise<readonly GoalMemoryReading[]> {
      const out: GoalMemoryReading[] = []
      for (const id of ids) {
        const record = await store.get(String(id) as MemoryId)
        if (record === null) continue
        out.push(memoryReadingOf(record))
      }
      return out
    },
  }
}

export function createGoalBeliefLookup(db: RawDb, characterId: string): GoalBeliefLookup {
  return {
    async findBeliefs(ids: readonly string[]): Promise<readonly GoalBeliefReading[]> {
      const out: GoalBeliefReading[] = []
      for (const id of ids) {
        const row = await getBelief(db, characterId as never, String(id))
        if (row === undefined) continue
        const state = row.state
        out.push({
          beliefId: String(state.beliefId),
          /*
           * ⚠️ 这里是**投影行**的 revision，不是 state 里的字段 ——
           *    `BeliefState` 没有版本号（WP0 基线报告 §3 的 Q2）。
           *    引用携带它，复核才能回答"这个指针是不是旧快照"。
           */
          projectionRevision: row.revision,
          perspectiveOwnerId: String(state.perspectiveOwnerId),
          subjectKind: state.subject.kind,
          subjectId: String(state.subject.id),
          status: state.status,
          epistemicKind: state.epistemicKind,
          supportLevel: state.supportLevel,
          evidenceRootIds: state.evidenceRootIds.map(String),
          dependsOnMemoryIds: state.dependsOnMemoryIds.map(String),
        })
      }
      return out
    },
  }
}

export function createGoalWithdrawnLookup(
  db: RawDb,
  store: MemoryStorePort,
  owner: EntityRef,
): GoalWithdrawnLookup {
  return {
    compute: () => computeWithdrawnEvidence(db, store, owner),
  }
}

// ---------------------------------------------------------------------------
// 装配（一个入口）
// ---------------------------------------------------------------------------

export interface CreateGoalInputPortsInput {
  readonly db: RawDb
  /** 记忆库端口。缺省 = 本 DB 上的原生实现 */
  readonly store?: MemoryStorePort
  /** 记忆属主（character）；也是撤销集的 owner */
  readonly owner: EntityRef
  readonly policy: GoalInputPorts['policy']
}

/**
 * 装配层唯一该调的入口。
 *
 * ⚠️ `policy.characterId` 与 `owner.id` **必须一致**：不一致时读出来的记录
 *    一定会在身份隔离那道闸上被判 `foreign` —— 而那时真正的原因是这个装配参数，
 *    不是数据。这里做成**构造期失败**，而不是让它变成一条看起来像数据的拒绝。
 */
export function createGoalInputPorts(input: CreateGoalInputPortsInput): GoalInputPorts {
  const store = input.store ?? createNativeMemoryStore(input.db)
  if (String(input.owner.id) !== input.policy.characterId) {
    throw new Error(
      `Goal 输入装配不一致：owner.id=${String(input.owner.id)} 与 ` +
        `policy.characterId=${input.policy.characterId} 不等 ⇒ 所有依赖都会被判 foreign。` +
        '这是装配参数错，不是数据问题（在构造期失败，不伪装成一条业务拒绝）',
    )
  }
  return {
    memory: createGoalMemoryLookup(store),
    belief: createGoalBeliefLookup(input.db, input.policy.characterId),
    withdrawn: createGoalWithdrawnLookup(input.db, store, input.owner),
    policy: input.policy,
  }
}
