/**
 * A1 / **WP2：`goals_commitments` 只读面的真端口**（第四个面）。
 *
 * ============================================================================
 *  口径（与其余面一致）
 * ============================================================================
 * ```text
 * · 字段闭集（冻结清单）：`openGoals` / `completedGoals` / `openCommitments` / `settledCommitments`
 * · 读数由**注入**的 reader 提供（复用既有投影/账本）—— 本模块**不** import 数据库、**不**重算认知
 * · 没接 reader ⇒ 四个字段全 `null` **且**整面进 `unavailable`（**不**用 0 冒充"没有目标/承诺"）
 *   ⚠️ 0 与"不知道"在目标/承诺上是**两件事**：0 会被读成"她没有任何承诺"。
 * ```
 */
import type { AdminReadSurfacePayload } from '../admin/query-ports.ts'

/** 目标与承诺的计数读数（**注入**） */
export interface GoalsCommitmentsReader {
  counts(): Promise<{
    openGoals: number
    completedGoals: number
    openCommitments: number
    settledCommitments: number
  }>
}

export interface GoalsCommitmentsPortInput {
  readonly reader?: GoalsCommitmentsReader | undefined
  readonly now?: (() => Date) | undefined
}

/** 四个字段名（`unavailable` 里逐个列出；与冻结清单一致） */
export const GOALS_COMMITMENTS_FIELDS: readonly string[] = [
  'openGoals', 'completedGoals', 'openCommitments', 'settledCommitments',
]

/** 计数合法性（**纯函数**：非负整数才算；否则如实标 `invalid` 而不是硬塞一个数） */
export function countProblem(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'invalid'
  return undefined
}

export function createGoalsCommitmentsPort(
  input: GoalsCommitmentsPortInput
): () => Promise<AdminReadSurfacePayload> {
  return async () => {
    const generatedAt = (input.now ?? (() => new Date()))().toISOString()
    const blank: Record<string, unknown> = {
      openGoals: null, completedGoals: null, openCommitments: null, settledCommitments: null,
    }
    if (input.reader === undefined) {
      return { surface: 'goals_commitments', generatedAt, items: [blank], unavailable: [...GOALS_COMMITMENTS_FIELDS] }
    }
    try {
      const counts = await input.reader.counts()
      const invalid = GOALS_COMMITMENTS_FIELDS.filter((field) =>
        countProblem((counts as unknown as Record<string, unknown>)[field]) !== undefined)
      if (invalid.length > 0) {
        /* 读数形状不对 ⇒ 如实"不可用"，**不**把坏值当数字报出去 */
        return { surface: 'goals_commitments', generatedAt, items: [blank], unavailable: invalid }
      }
      return {
        surface: 'goals_commitments',
        generatedAt,
        items: [{
          openGoals: counts.openGoals,
          completedGoals: counts.completedGoals,
          openCommitments: counts.openCommitments,
          settledCommitments: counts.settledCommitments,
        }],
      }
    } catch {
      /* 读失败 ⇒ 与"没接"同形（都是"不知道"），**不**退化成 0 */
      return { surface: 'goals_commitments', generatedAt, items: [blank], unavailable: [...GOALS_COMMITMENTS_FIELDS] }
    }
  }
}
