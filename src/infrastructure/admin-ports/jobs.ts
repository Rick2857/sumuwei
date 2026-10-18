/**
 * A1 / **WP2：`jobs` 只读面的真端口**（第三个面；缺口 `B9` 的 **cursor 分页**在这里）。
 *
 * ============================================================================
 *  三条刻意的设计
 * ============================================================================
 * ```text
 * ① **游标不透明**：服务端只校验**形状**（base64url，≤120 字符），解释权在 reader。
 *    形状不合法 ⇒ `AdminQueryError('bad_cursor')` ⇒ 服务端回 **400**（不是 500：
 *    "你传错了"与"我们坏了"必须分开，否则运维会去查一个不存在的故障）。
 * ② **条数上限在端口里夹紧**（缺省 20 / 上限 50）：页面给 `limit=99999` 也拿不到大页。
 * ③ **没接 reader ⇒ 整面 `unavailable`**（空数组 + 具名），**不**用空数组冒充"没有任务"。
 * ```
 * ⚠️ 持久化 jobId（`WP4`）**不在本切片**：这里读的是**注入**的 reader（进程内或持久实现都行）。
 */
import { createHash } from 'node:crypto'
import { AdminQueryError, cursorShapeProblem, type AdminPageInput, type AdminReadSurfacePayload } from '../admin/query-ports.ts'

/** 一页任务记录（**字段闭集**与冻结清单一致：多一个字段由服务端按闭集裁掉） */
export interface JobRecord {
  readonly jobId: string
  readonly kind: string
  readonly state: string
  readonly startedAt: string
  readonly finishedAt?: string | undefined
  readonly failureReason?: string | undefined
}

/** 任务 reader（**注入**；实现方决定进程内还是持久） */
export interface JobsReader {
  list(input: { cursor?: string | undefined; limit: number }): Promise<{ items: readonly JobRecord[]; nextCursor?: string | undefined }>
}

export interface JobsPortInput {
  readonly reader?: JobsReader | undefined
  /** 缺省页大小（缺省 20；夹到 [1,50]） */
  readonly pageSize?: number | undefined
  readonly now?: (() => Date) | undefined
}

/** 页大小的**夹紧**（纯函数，门直接测） */
export function clampJobPageSize(limit: number | undefined, pageSize = 20): number {
  const base = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 20
  if (limit === undefined) return Math.min(base, 50)
  if (!Number.isSafeInteger(limit) || limit <= 0) return Math.min(base, 50)
  return Math.min(limit, 50)
}

// ---------------------------------------------------------------------------
// WP4：持久幂等 + jobId 的**纯核心**（`ADR-135` `R-A1-3`，用户 2026-10-14 批准）
// ---------------------------------------------------------------------------

/**
 * 任务状态闭集（`R-A1-3` 逐字：执行前**原子登记**、重复提交**返回原任务**、
 * 同键**不同参数明确拒绝**、重启后"执行中"标**中断/待核验**且**不自动重跑**）。
 */
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted'

export const JOB_STATES: readonly JobState[] = ['pending', 'running', 'succeeded', 'failed', 'interrupted']

/** 终态（**不**再变；"中断"也算终态 —— 它要人核验，不许自动重跑） */
export const JOB_TERMINAL_STATES: readonly JobState[] = ['succeeded', 'failed', 'interrupted']

export function isJobTerminal(state: JobState): boolean {
  return JOB_TERMINAL_STATES.includes(state)
}

/**
 * 参数指纹（**纯函数**）：稳定序列化 + sha256。
 *
 * ⚠️ 键**排序**后再序列化 —— 否则 `{a:1,b:2}` 与 `{b:2,a:1}` 会得到不同指纹，
 *    于是"同键不同参数"的判据会**误报冲突**（把同一次提交当成两次）。
 */
export function parameterFingerprint(params: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(canonical)
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = canonical(record[key])
    return out
  }
  return createHash('sha256').update(JSON.stringify(canonical(params) ?? null), 'utf8').digest('hex')
}

/** 受理判定（**纯函数**）：`create` = 新任务 · `replay` = 返回原任务 · `conflict` = 同键不同参数 */
export interface JobAdmission {
  readonly kind: 'create' | 'replay' | 'conflict'
  readonly reason: string
  /** `replay` / `conflict` 时指向**已存在**的那条任务 */
  readonly existingJobId?: string | undefined
}

export function jobAdmissionDecision(input: {
  readonly existing?: { jobId: string; idempotencyKey: string; fingerprint: string } | undefined
  readonly incoming: { idempotencyKey: string; fingerprint: string }
}): JobAdmission {
  const { existing, incoming } = input
  if (existing === undefined) return { kind: 'create', reason: 'no_existing_job' }
  if (existing.idempotencyKey !== incoming.idempotencyKey) {
    /* 理论上调用方是按幂等键查的；键不同 ⇒ 把它当新任务，但**说清**理由 */
    return { kind: 'create', reason: 'different_idempotency_key' }
  }
  if (existing.fingerprint !== incoming.fingerprint) {
    return { kind: 'conflict', reason: 'same_key_different_params', existingJobId: existing.jobId }
  }
  return { kind: 'replay', reason: 'same_key_same_params', existingJobId: existing.jobId }
}

/**
 * 重启后的状态修复（**纯函数**）：`running` ⇒ `interrupted`（待核验），**其余原样**。
 *
 * ⚠️ 关键：**不自动重跑**。`interrupted` 是终态，只有人核验后重新提交（新幂等键或显式重试）才会再跑。
 */
export function recoveredJobState(state: JobState): JobState {
  return state === 'running' ? 'interrupted' : state
}

/**
 * **状态的人读标签**（契约 §5 的"真假"一行：`accepted ≠ 执行成功`）。
 *
 * ```text
 * ⚠️ 这张表的**唯一职责**是"不许把'已受理'说成'已完成'"：
 *    · `pending`  ⇒ 「已提交（尚未执行）」—— 平台收下了，**没有**任何执行发生
 *    · `running`  ⇒ 「执行中」
 *    · `succeeded`⇒ 「成功」· `failed` ⇒ 「失败」
 *    · `interrupted` ⇒ 「中断（待核验）」—— **不**说"失败"（不知道就是不知道），也**不**自动重跑
 * ⚠️ 未知状态 ⇒ 「未知状态」**原样带出**状态串（不猜、不美化）
 * ```
 */
export function jobStateLabel(state: string): string {
  switch (state) {
    case 'pending':
      return '已提交（尚未执行）'
    case 'running':
      return '执行中'
    case 'succeeded':
      return '成功'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '中断（待核验）'
    default:
      return `未知状态：${state}`
  }
}

export function createJobsPort(input: JobsPortInput): (page?: AdminPageInput) => Promise<AdminReadSurfacePayload> {
  return async (page) => {
    const generatedAt = (input.now ?? (() => new Date()))().toISOString()
    if (input.reader === undefined) {
      /* 整面没接线：空数组 + 具名 unavailable（**不**让空数组冒充"没有任务"） */
      return { surface: 'jobs', generatedAt, items: [], unavailable: ['jobs'] }
    }
    const shape = cursorShapeProblem(page?.cursor)
    if (shape !== undefined) throw new AdminQueryError('bad_cursor', '游标形状不合法（不是不透明串）')
    const limit = clampJobPageSize(page?.limit, input.pageSize)
    const listed = await input.reader.list({
      ...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
      limit,
    })
    const items = listed.items.slice(0, limit).map((record) => ({
      jobId: record.jobId,
      kind: record.kind,
      state: record.state,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
    }))
    return {
      surface: 'jobs',
      generatedAt,
      items,
      ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
    }
  }
}
