/**
 * A1 / **WP2：`cognition` 只读面的真端口**（第五个面 · 最后一个）。
 *
 * ============================================================================
 *  口径（与其余面一致）
 * ============================================================================
 * ```text
 * · 字段闭集（冻结清单）：`characterId` / `affect` / `relationships` / `beliefs` / `watermarks`
 * · 读数由**注入**的 reader 提供（复用既有投影/折叠结果）—— 本模块**不** import 数据库、**不**重算认知
 *   ⚠️ "不重算"是硬要求（`D01`）：这一面只**呈现**已有投影，不许在这里跑折叠/推导
 * · 没接 reader / 读失败 ⇒ 五个字段全 `null` **且**整面进 `unavailable`（**不**用 `{}`/`0` 冒充"没有认知状态"）
 * ```
 */
import type { AdminReadSurfacePayload } from '../admin/query-ports.ts'

/** 认知读数（**注入**：实现方从既有投影读，**不**在本模块推导） */
export interface CognitionReader {
  read(): Promise<{
    characterId: string
    affect?: unknown
    relationships?: unknown
    beliefs?: unknown
    watermarks?: unknown
  }>
}

export interface CognitionPortInput {
  readonly reader?: CognitionReader | undefined
  readonly now?: (() => Date) | undefined
}

/** 五个字段名（`unavailable` 里逐个列出；与冻结清单一致） */
export const COGNITION_FIELDS: readonly string[] = ['characterId', 'affect', 'relationships', 'beliefs', 'watermarks']

export function createCognitionPort(input: CognitionPortInput): () => Promise<AdminReadSurfacePayload> {
  return async () => {
    const generatedAt = (input.now ?? (() => new Date()))().toISOString()
    const blank: Record<string, unknown> = {
      characterId: null, affect: null, relationships: null, beliefs: null, watermarks: null,
    }
    if (input.reader === undefined) {
      return { surface: 'cognition', generatedAt, items: [blank], unavailable: [...COGNITION_FIELDS] }
    }
    try {
      const reading = await input.reader.read()
      const unavailable: string[] = []
      if (typeof reading.characterId !== 'string' || reading.characterId.trim() === '') {
        unavailable.push('characterId')
      }
      /*
       * ⚠️ `affect` / `relationships` / `beliefs` / `watermarks` 可以是**任意形状**（各域自己定），
       *    但 `undefined` 一律算"这一格今天没有"（进 `unavailable`），**不**写成 `{}`（`{}` 会被读成"空状态"）。
       */
      for (const field of ['affect', 'relationships', 'beliefs', 'watermarks'] as const) {
        if (reading[field] === undefined || reading[field] === null) unavailable.push(field)
      }
      return {
        surface: 'cognition',
        generatedAt,
        items: [{
          characterId: typeof reading.characterId === 'string' && reading.characterId.trim() !== '' ? reading.characterId : null,
          affect: reading.affect ?? null,
          relationships: reading.relationships ?? null,
          beliefs: reading.beliefs ?? null,
          watermarks: reading.watermarks ?? null,
        }],
        ...(unavailable.length === 0 ? {} : { unavailable }),
      }
    } catch {
      return { surface: 'cognition', generatedAt, items: [blank], unavailable: [...COGNITION_FIELDS] }
    }
  }
}
