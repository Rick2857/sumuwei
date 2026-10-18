/**
 * A1 / **WP4 受控写端口 `jobs.admit`**（用户 2026-10-14 裁定「按这个设计做」；唯一写面）。
 *
 * ============================================================================
 *  闸序与失败关闭（本端口负责的那一半）
 * ============================================================================
 * ```text
 * ① **审计先写**：审计写不进 ⇒ **不登记任务**（`audit_unavailable`，任务表一行都不动）
 *    ⚠️ 为什么审计在前：反过来（先登记再审计）一旦审计失败，任务**已经进库**了 ⇒ 那是"记过但没账"，
 *    事后无法自证。本仓库对这类顺序有硬要求（`D09`：审计落库失败 ⇒ 失败关闭）。
 * ② **幂等登记**（复用 `admin-jobs-store.admit`：同键同参数 ⇒ `replay` 返回**原任务**；
 *    同键不同参数 ⇒ `conflict` ⇒ 抛 `idempotency_conflict` ⇒ 服务端回 **409**）
 * ③ 登记失败 ⇒ **尽力**补一条失败审计（带原因码），**不**掩盖第一次成功那条
 * ```
 *
 * ⚠️ **受理 ≠ 执行成功**：登记后状态是 `pending`（界面文案「已提交（尚未执行）」）。
 *    今天**没有执行器**去跑它（明确不做），所以 `pending` 会停着 —— 那是**如实**状态，不是故障。
 * ⚠️ `jobId` 由**服务端**生成（`newJobIdOf`）：调用方**不许**自报 jobId。
 * ⚠️ `operator` 记**已认证**的管理身份（`adminId` 来自会话，不来自请求体）。
 */
import type { AdminWritePorts } from '../admin/query-ports.ts'

/** 具名错误：带 `code`，服务端据此选状态码（409 / 500） */
export class AdminWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AdminWriteError'
  }
}

export interface JobsAdmitPortDeps {
  /** 登记（`admin-jobs-store` 的 `admit`；注入 ⇒ 本模块零数据库 import） */
  readonly admit: (input: {
    jobId: string
    operator: string
    kind: string
    idempotencyKey: string
    params: unknown
    now?: number | undefined
  }) => Promise<{ admission: { kind: string; reason: string; existingJobId?: string | undefined }; job: { jobId: string; state: string } }>
  /** **审计**（必须落库；抛错 ⇒ 本端口**不登记任务**） */
  readonly audit: (record: {
    readonly command: 'JOBS_ADMIT'
    readonly result: 'verified' | 'rejected'
    readonly reasonCode?: string | undefined
    readonly idempotencyKey: string
    readonly operator: string
    readonly jobId: string
  }) => Promise<void>
  /** 服务端生成 jobId（**不**用调用方的） */
  readonly newJobIdOf: () => string
  /** 时钟（便于门固定时间） */
  readonly now?: () => number
}

export function createJobsAdmitWritePort(deps: JobsAdmitPortDeps): AdminWritePorts['jobsAdmit'] {
  return async (input) => {
    const at = deps.now?.() ?? Date.now()
    const jobId = deps.newJobIdOf()

    /* ① 审计**先写**；写不进 ⇒ 失败关闭（任务表一行都不动） */
    try {
      await deps.audit({
        command: 'JOBS_ADMIT',
        result: 'verified',
        idempotencyKey: input.idempotencyKey,
        operator: input.adminId,
        jobId,
      })
    } catch (error) {
      throw new AdminWriteError(
        'audit_unavailable',
        `审计写不进 ⇒ 不登记任务（${error instanceof Error ? error.message : String(error)}）`
      )
    }

    /* ② 幂等登记 */
    try {
      const result = await deps.admit({
        jobId,
        operator: input.adminId,
        kind: 'JOBS_ADMIT',
        idempotencyKey: input.idempotencyKey,
        params: input.params,
        now: at,
      })
      if (result.admission.kind === 'conflict') {
        /* 同键不同参数 ⇒ **明确拒绝**（不静默新建第二个任务） */
        throw new AdminWriteError('idempotency_conflict', '同一幂等键、不同参数 ⇒ 拒绝')
      }
      return {
        admission: result.admission.kind === 'replay' ? 'replayed' : 'created',
        jobId: result.job.jobId,
        state: result.job.state,
      }
    } catch (error) {
      /* ③ 登记失败 ⇒ **尽力**补一条失败审计（不掩盖第一次那条） */
      try {
        await deps.audit({
          command: 'JOBS_ADMIT',
          result: 'rejected',
          reasonCode: error instanceof AdminWriteError ? error.code : 'admit_failed',
          idempotencyKey: input.idempotencyKey,
          operator: input.adminId,
          jobId,
        })
      } catch {
        /* 补记失败也失败 ⇒ **如实**：这条以第一次审计为准（它已落库），补记只是附加信息 */
      }
      throw error instanceof AdminWriteError ? error : new AdminWriteError('admit_failed', '登记失败')
    }
  }
}
