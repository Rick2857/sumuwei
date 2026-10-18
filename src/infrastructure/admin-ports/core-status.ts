/**
 * A1 / **第六个面 `core_status`**（用户 2026-10-14 裁定「核心状态加进页面，加第六个面」；`R-A1-5`）。
 *
 * ```text
 * 数据来源 = **只读**探针 `readCorePresence`（查 `pg_locks` 里的单认知执行者资格锁）
 * 三态      online / offline / **null（查不出来）** —— 界面上 `null` 说"未知"，**绝不**说"离线"
 * 依赖**注入**的 reader ⇒ 本模块零数据库 import（依赖边界判据继续成立）
 * ⚠️ 不带 `--with-db` ⇒ 没有 reader ⇒ 该面如实 `unavailable: ['presence']`（**不**编一个"离线"）
 * ```
 */
import type { AdminPageInput, AdminReadSurfacePayload } from '../admin/query-ports.ts'
import { corePresenceLabel, type CorePresence } from '../admin/query-ports.ts'

export interface CoreStatusRow {
  /** 三态原值（`null` = 查不出来；JSON 里就是 `null`，**不**换成字符串） */
  readonly presence: CorePresence
  /** 人读文案（「核心在线」/「核心离线」/「核心状态未知（读不到资格锁）」） */
  readonly label: string
  /** 匹配到的资格锁行数（查不出来时**缺格**，不编 0） */
  readonly heldCount?: number | undefined
}

export interface CoreStatusReader {
  read(): Promise<{
    presence: CorePresence
    heldCount?: number | undefined
    unavailableReason?: string | undefined
  }>
}

export function createCoreStatusPort(options: { readonly reader?: CoreStatusReader | undefined }) {
  /*
   * ⚠️ 必须返回**函数**（不是 `{ read }` 对象）：路由 `server.ts` 用
   *    `typeof ports[ADMIN_PORT_METHOD[surface.id]] !== 'function'` 判 `501 surface_not_wired`
   *    —— 返回对象会被当成"没接线"（第一版踩了，红在 live 门的三条断言上）。
   */
  return async (_input?: AdminPageInput): Promise<AdminReadSurfacePayload> => {
    if (options.reader === undefined) {
      /* 没接 reader ⇒ **如实**说这一格读不到（不是"核心离线"） */
      return { surface: 'core_status', generatedAt: new Date().toISOString(), items: [], unavailable: ['presence'] }
    }
    const reading = await options.reader.read()
    /* ⚠️ 形状要与 `AdminReadSurfacePayload` 的条目类型对齐（`Record<string, unknown>`）——
       第一版用了 interface `CoreStatusRow` ⇒ tsc 判 TS2322（接口没有索引签名）。 */
    const row: Record<string, unknown> = {
      presence: reading.presence,
      label: corePresenceLabel(reading.presence),
      ...(reading.heldCount === undefined ? {} : { heldCount: reading.heldCount }),
    }
    /*
     * ⚠️ **三态各自如实**：查不出来时**只**列 `unavailable` 的**原因**，
     *    绝不把 `presence` 从 `null` 改成 `'offline'`。
     */
    return reading.unavailableReason === undefined
      ? { surface: 'core_status', generatedAt: new Date().toISOString(), items: [row] }
      : { surface: 'core_status', generatedAt: new Date().toISOString(), items: [row], unavailable: [reading.unavailableReason] }
  }
}
