/**
 * A1 / **WP2：`cognition` reader 的**选择半**（纯函数）**。
 *
 * ============================================================================
 *  为什么先写这一半
 * ============================================================================
 * ```text
 * 这一面最容易犯两个错：
 *   ① **顺手算一下**（把 beliefs 折成结论、把 affect 折算成强度）—— 那是"重算认知"（`D01` 禁止）
 *   ② **朴素前缀过滤踩坑**：`belief:` 会命中 `belief:origin`
 *      （`contracts/belief.ts:128`；`belief-store.ts:120`/`:147` 都**显式跳过**它）
 *      ⇒ `beliefs` 那一格会**多报一条**，属于"看起来对、其实错"的假读数
 * 所以选择逻辑写成**纯函数**并逐条测；真正的 `db` 读法（`listProjections` / `projectionRevisions` /
 * `getProjection`）等注入时再接。
 * ```
 *
 * 口径（已核对，见交接单 §4①）：
 * ```text
 * affect        ← 单行投影 `affect:character`（**不是**前缀集合）
 * relationships ← 前缀 `relationship:`
 * beliefs       ← 前缀 `belief:` **且排除 `belief:origin`**
 * watermarks    ← 各投影当前 revision（由调用方注入，本模块只做键值整理）
 * ```
 */
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { RawDb } from '../persistence/db.ts'
import { listProjections, projectionRevisions } from '../persistence/event-store.ts'
import type { CognitionReader } from '../admin-ports/cognition.ts'

/** 已核对的三类投影标识（改这里必须同步交接单 §4① 与门） */
export const COGNITION_AFFECT_TYPE = 'affect:character'
export const COGNITION_RELATIONSHIP_PREFIX = 'relationship:'
export const COGNITION_BELIEF_PREFIX = 'belief:'
/** ⚠️ 记账行：**不是**一条信念，必须排除 */
export const COGNITION_BELIEF_ORIGIN_TYPE = 'belief:origin'

/** 投影行的最小形状（`CharacterProjection` 的子集；不依赖持久层类型） */
export interface ProjectionRowLike {
  readonly projectionType: string
  readonly state: unknown
}

/** `affect`：**精确匹配**单行投影（前缀过滤在这里是错的） */
export function selectAffect(rows: readonly ProjectionRowLike[]): unknown | undefined {
  const row = rows.find((candidate) => candidate.projectionType === COGNITION_AFFECT_TYPE)
  return row?.state
}

/** `relationships`：前缀匹配 */
export function selectRelationships(rows: readonly ProjectionRowLike[]): unknown[] {
  return rows.filter((row) => row.projectionType.startsWith(COGNITION_RELATIONSHIP_PREFIX)).map((row) => row.state)
}

/**
 * `beliefs`：前缀匹配 **且排除 `belief:origin`**。
 *
 * ⚠️ 排除这一条**不是**可选优化：`belief:origin` 是背书/来源的记账行，
 *    带进列表就会让"她相信几条"多报一条（本仓库对"看起来对"的读数零容忍）。
 */
export function selectBeliefs(rows: readonly ProjectionRowLike[]): unknown[] {
  return rows
    .filter((row) =>
      row.projectionType.startsWith(COGNITION_BELIEF_PREFIX) &&
      row.projectionType !== COGNITION_BELIEF_ORIGIN_TYPE)
    .map((row) => row.state)
}

/** 水位/版本：把"投影类型 ⇒ revision"整理成普通对象（**不**自造水位概念） */
export function selectWatermarks(revisions: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(revisions).sort()) {
    const value = revisions[key]
    if (typeof value === 'number' && Number.isSafeInteger(value)) out[key] = value
  }
  return out
}

/** 五格的**原样呈现**（本模块不推导、不折算、不排序之外的重排） */
export interface CognitionCells {
  characterId: string | null
  affect: unknown
  relationships: unknown[]
  beliefs: unknown[]
  watermarks: Record<string, number>
}

export function cognitionCellsFromProjections(input: {
  readonly characterId: CharacterId | string
  readonly rows: readonly ProjectionRowLike[]
  readonly revisions: Readonly<Record<string, number>>
}): CognitionCells {
  const id = typeof input.characterId === 'string' && input.characterId.trim() !== '' ? input.characterId : null
  const affect = selectAffect(input.rows)
  return {
    characterId: id,
    affect: affect ?? null,
    relationships: selectRelationships(input.rows),
    beliefs: selectBeliefs(input.rows),
    watermarks: selectWatermarks(input.revisions),
  }
}

/**
 * 建 reader（**只读**）。
 *
 * ```text
 * 行      `listProjections(db, characterId)`（`event-store.ts:477`，**只读**；按 projection_type 升序）
 * 水位    `projectionRevisions(db, characterId)`（`event-store.ts:491`，返回 `Record<string, number>`）
 * 组合    上面两个 ⇒ `cognitionCellsFromProjections`（**纯函数**，已被门穷举测过）
 * ```
 *
 * ⚠️ `db` 由装配根注入：本模块**不**开库、不读环境、不碰生产库。
 * ⚠️ 只调**读**入口：`saveProjection` / `insertProjection` / `deleteProjection` 一律不碰。
 */
export function createCognitionReader(input: {
  readonly db: RawDb
  readonly characterId: CharacterId
}): CognitionReader {
  return {
    read: async () => {
      const [rows, revisions] = await Promise.all([
        listProjections(input.db, input.characterId),
        projectionRevisions(input.db, input.characterId),
      ])
      const cells = cognitionCellsFromProjections({
        characterId: input.characterId,
        rows: rows.map((row) => ({ projectionType: String(row.projectionType), state: row.state })),
        revisions,
      })
      /* 空身份 ⇒ 回空串（端口会把它算成缺格 ⇒ 如实 `unavailable`；**不**编一个 id） */
      return {
        characterId: cells.characterId ?? '',
        affect: cells.affect ?? undefined,
        relationships: cells.relationships,
        beliefs: cells.beliefs,
        watermarks: cells.watermarks,
      }
    },
  }
}
