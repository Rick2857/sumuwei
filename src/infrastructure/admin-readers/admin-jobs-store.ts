/**
 * A1 / **WP4：`admin_jobs` 的仓储**（真表读写；`R-A1-3` 逐字：**执行前原子登记**）。
 *
 * ============================================================================
 *  它在哪一层、为什么
 * ============================================================================
 * ```text
 * `admin/**` 与 `admin-ports/**` 被依赖边界判据**禁止** import 持久层
 * （端口只吃注入的实现）⇒ 真要读库的那一层放这里（与三个 reader 同层）。
 * ```
 *
 * 三条刻意的设计：
 * ```text
 * ① **原子登记**：插入即占用幂等键（唯一索引）—— 靠 `on conflict do nothing` + 回读，
 *    而不是"先查再插"（那中间有窗口，两个并发会都以为自己是第一个）
 * ② **受理判定复用纯核心**（`jobAdmissionDecision` / `parameterFingerprint` / `recoveredJobState`）
 * ③ **不自动重跑**：`recoverInterrupted()` 只把 `running` 标成 `interrupted`（待核验）
 * ```
 * ⚠️ 裸 SQL 走 `exec(db, sql\`…\`, '<标签>')`（本仓库既有形状：`event-store.ts` 同款）——
 *    第一版我用了 `rowsOf(db, sql…)`，签名是 `rowsOf(result)` ⇒ 编译不过（已修）。
 */
import { sql } from 'drizzle-orm'
import type { RawDb } from '../persistence/db.ts'
import { exec } from '../persistence/db.ts'
import {
  jobAdmissionDecision,
  parameterFingerprint,
  recoveredJobState,
  type JobAdmission,
  type JobState,
} from '../admin-ports/jobs.ts'

export interface AdminJobRow {
  readonly jobId: string
  readonly operator: string
  readonly kind: string
  readonly idempotencyKey: string
  readonly paramsFingerprint: string
  readonly state: JobState
  readonly resultRef?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AdminJobsStore {
  /** **执行前原子登记**：新任务 ⇒ `create`；同键同参数 ⇒ `replay`；同键不同参数 ⇒ `conflict` */
  admit(input: {
    jobId: string
    operator: string
    kind: string
    idempotencyKey: string
    params: unknown
    now?: number | undefined
  }): Promise<{ admission: JobAdmission; job: AdminJobRow }>
  /** 状态推进（**终态不可再改**） */
  markState(input: { jobId: string; state: JobState; resultRef?: string | undefined; now?: number | undefined }): Promise<AdminJobRow | undefined>
  /** 按 `jobId` 读回（断线/刷新后"按 jobId 读回结果"用） */
  read(jobId: string): Promise<AdminJobRow | undefined>
  /**
   * 按**幂等键**读回（**只读**）。
   *
   * ⚠️ 2026-10-14 live 门抓到：因为网关按幂等键**重放**且**不比较参数指纹**，
   *    "同键不同参数 ⇒ 明确拒绝"这条必须在**有数据的那一层**判 ⇒ 需要这个只读入口。
   */
  findByIdempotencyKey(key: string): Promise<AdminJobRow | undefined>
  /**
   * **keyset 分页**（`job_id` 升序，游标 = 上一页最后一条的 `job_id`）。
   *
   * ⚠️ 用 keyset 而不是 `offset`：后者在"边翻边有新任务"时会**漏行/重复行**（本仓库对"看起来对"零容忍）。
   * ⚠️ 游标是**不透明**的（服务端只回传，解释权在这里）。
   */
  list(input: { cursor?: string | undefined; limit: number }): Promise<{ items: readonly AdminJobRow[]; nextCursor?: string | undefined }>
  /** **重启后**：`running` ⇒ `interrupted`（待核验），**不自动重跑**；返回改了几条 */
  recoverInterrupted(): Promise<number>
}

const rowOf = (raw: Record<string, unknown>): AdminJobRow => ({
  jobId: String(raw.job_id),
  operator: String(raw.operator),
  kind: String(raw.kind),
  idempotencyKey: String(raw.idempotency_key),
  paramsFingerprint: String(raw.params_fingerprint),
  state: String(raw.state) as JobState,
  ...(raw.result_ref === null || raw.result_ref === undefined ? {} : { resultRef: String(raw.result_ref) }),
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
})

const TERMINAL: readonly JobState[] = ['succeeded', 'failed', 'interrupted']

export function createAdminJobsStore(db: RawDb): AdminJobsStore {
  const selectByKey = async (key: string): Promise<AdminJobRow | undefined> => {
    const rows = await exec(db, sql`select * from admin_jobs where idempotency_key = ${key} limit 1`, '读任务（按幂等键）')
    return rows.length === 0 ? undefined : rowOf(rows[0]!)
  }
  const selectById = async (id: string): Promise<AdminJobRow | undefined> => {
    const rows = await exec(db, sql`select * from admin_jobs where job_id = ${id} limit 1`, '读任务（按 jobId）')
    return rows.length === 0 ? undefined : rowOf(rows[0]!)
  }

  return {
    admit: async (input) => {
      const at = input.now ?? Date.now()
      const fingerprint = parameterFingerprint(input.params)
      const existing = await selectByKey(input.idempotencyKey)
      if (existing !== undefined) {
        const admission = jobAdmissionDecision({
          existing: {
            jobId: existing.jobId,
            idempotencyKey: existing.idempotencyKey,
            fingerprint: existing.paramsFingerprint,
          },
          incoming: { idempotencyKey: input.idempotencyKey, fingerprint },
        })
        if (admission.kind !== 'create') return { admission, job: existing }
      }
      /* **原子占用**：`on conflict do nothing` + 回读（不用"先查再插"：那中间有窗口） */
      await exec(
        db,
        sql`insert into admin_jobs (job_id, operator, kind, idempotency_key, params_fingerprint, state, created_at, updated_at)
            values (${input.jobId}, ${input.operator}, ${input.kind}, ${input.idempotencyKey}, ${fingerprint}, 'pending', ${at}, ${at})
            on conflict (idempotency_key) do nothing`,
        '原子登记任务'
      )
      const stored = (await selectByKey(input.idempotencyKey)) ?? (await selectById(input.jobId))
      if (stored === undefined) {
        /* 插了却读不回：**如实抛**（不返回一个编出来的任务） */
        throw new Error('admin_jobs_admit_readback_failed')
      }
      if (stored.jobId !== input.jobId) {
        /* 并发下另一个进程先占了这个键 ⇒ 如实报 replay（返回**它**那条任务） */
        return { admission: { kind: 'replay', reason: 'concurrent_same_key', existingJobId: stored.jobId }, job: stored }
      }
      return { admission: { kind: 'create', reason: 'inserted' }, job: stored }
    },

    markState: async (input) => {
      const current = await selectById(input.jobId)
      if (current === undefined) return undefined
      if (TERMINAL.includes(current.state)) return current
      const at = input.now ?? Date.now()
      await exec(
        db,
        sql`update admin_jobs set state = ${input.state}, updated_at = ${at},
              result_ref = ${input.resultRef ?? null} where job_id = ${input.jobId}`,
        '推进任务状态'
      )
      return await selectById(input.jobId)
    },

    read: async (jobId) => await selectById(jobId),

    findByIdempotencyKey: async (key) => await selectByKey(key),

    list: async (input) => {
      const cap = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 20
      /* 多取一条用来判断"还有没有下一页"（不额外发一次 count 查询） */
      const rows = input.cursor === undefined || input.cursor === ''
        ? await exec(db, sql`select * from admin_jobs order by job_id asc limit ${cap + 1}`, '列出任务（首页）')
        : await exec(db, sql`select * from admin_jobs where job_id > ${input.cursor} order by job_id asc limit ${cap + 1}`, '列出任务（游标页）')
      const items = rows.slice(0, cap).map(rowOf)
      const nextCursor = rows.length > cap ? items[items.length - 1]?.jobId : undefined
      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) }
    },

    recoverInterrupted: async () => {
      const rows = await exec(db, sql`select job_id, state from admin_jobs where state = 'running'`, '读在跑任务')
      let changed = 0
      for (const row of rows) {
        const next = recoveredJobState(String(row.state) as JobState)
        if (next === String(row.state)) continue
        await exec(
          db,
          sql`update admin_jobs set state = ${next}, updated_at = ${Date.now()} where job_id = ${String(row.job_id)}`,
          '重启后标中断'
        )
        changed += 1
      }
      return changed
    },
  }
}

/** 供门使用：判断一行是否处在终态（与端口层 `isJobTerminal` 同义） */
export function isTerminalRow(row: AdminJobRow): boolean {
  return TERMINAL.includes(row.state)
}
