/**
 * A1 / WP4：`admin.jobs.admit` / `register` 的**适配器**（用户 2026-10-14 裁定走 ActionGateway）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 * ```text
 * 做：① 复核操作就是 `register`
 *     ② 复核参数闭集（只有 idempotencyKey / params / kind —— 多一个键就不是这个能力）
 *     ③ 拿到**幂等键**（拿不到 ⇒ 失败关闭：没有键的登记没法幂等）
 *     ④ 交给**注入的登记端口**（既有 `admin-jobs-store.admit()`，**不新建第二套真相**）
 *     ⑤ 回一个 effect = `job_registered` + **jobId**（**参数取值不进 effect**）
 * 不做：不决定该不该登记（策略层）· 不认识谁请求的（端口形状里没有身份字段）·
 *       **不**打开数据库 · **不**执行任务（今天没有执行器）
 * ```
 * ⚠️ **受理 ≠ 执行成功**：effect 只说"已登记"，状态是 `pending`；执行器是另一件事。
 * ⚠️ 失败一律走闭集 `ActionFailureCode`，我们自己的具名理由进 `details.reason`
 *    （与 `qq-proactive-delivery` / `browser` / `desktop-control` 同一条纪律）。
 */
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import { ADMIN_JOBS_ADMIT } from '../../../kernel/action/admin-jobs-capability.ts'

export const ADMIN_JOBS_REGISTER_OPERATION = 'register'

/** 参数闭集（**多一个键就不是这个能力**） */
export const ADMIN_JOBS_ADMIT_ARG_KEYS: readonly string[] = ['idempotencyKey', 'params', 'kind']

export interface AdminJobAdmitPort {
  admit(input: {
    jobId: string
    operator: string
    kind: string
    idempotencyKey: string
    params: unknown
  }): Promise<{
    admission: { kind: string; reason: string; existingJobId?: string | undefined }
    job: { jobId: string; state: string }
  }>
}

export interface AdminJobsAdapterOptions {
  readonly admit: AdminJobAdmitPort['admit']
  /** 服务端生成 jobId（**不**用调用方的） */
  readonly newJobIdOf: () => string
  /** 已认证的管理身份（会话侧来的；**不**从参数取） */
  readonly operatorOf: () => string
}

function fail(code: Parameters<typeof actionFailure>[0], reason: string, message: string): never {
  throw new ActionFailureError(actionFailure(code, message, { reason }))
}

export function createAdminJobsAdmitAdapter(options: AdminJobsAdapterOptions): CapabilityAdapter {
  return {
    capabilityId: ADMIN_JOBS_ADMIT,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      if (input.operation !== ADMIN_JOBS_REGISTER_OPERATION) {
        fail('validation_failed', 'admin_jobs_unknown_operation',
          `admin.jobs.admit 只有 ${ADMIN_JOBS_REGISTER_OPERATION} 这一个操作，收到 ${input.operation}`)
      }

      /* ① 参数闭集复核 */
      const extra = Object.keys(input.args ?? {}).filter((key) => !ADMIN_JOBS_ADMIT_ARG_KEYS.includes(key))
      if (extra.length > 0) {
        fail('validation_failed', 'admin_jobs_unknown_arg',
          `admin.jobs.admit 的参数闭集是 ${ADMIN_JOBS_ADMIT_ARG_KEYS.join(' / ')}，收到多余键：${extra.sort().join(', ')}`)
      }

      /* ② 幂等键**必需**（没有键就没法幂等 ⇒ 失败关闭，不替调用方编一个） */
      const rawKey = input.args?.['idempotencyKey']
      const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : ''
      if (idempotencyKey === '') {
        fail('validation_failed', 'admin_jobs_without_idempotency_key',
          '登记任务必须有幂等键（能力声明 idempotency=required）—— 不许替调用方编一个')
      }

      /* ③ 登记（既有 store；`conflict` ⇒ 明确拒绝，**不**静默新建第二个任务） */
      const result = await options.admit({
        jobId: options.newJobIdOf(),
        operator: options.operatorOf(),
        kind: 'JOBS_ADMIT',
        idempotencyKey,
        params: input.args?.['params'] ?? {},
      })
      if (result.admission.kind === 'conflict') {
        fail('validation_failed', 'admin_jobs_idempotency_conflict',
          '同一幂等键、不同参数 ⇒ 拒绝（不静默新建第二个任务）')
      }

      /*
       * ④ effect 只带 **jobId** 与状态：⚠️ **参数取值不进 effect**（进账本等于把参数复制一份长期留存）。
       *    幂等命中（`replay`）也走同一个 effect —— 它说的是"已登记的那一条"。
       */
      return {
        effect: {
          kind: 'job_registered',
          detail: result.admission.kind === 'replay' ? '幂等命中：返回已登记的那一条' : '已登记（尚未执行）',
          fingerprint: result.job.jobId,
          bytes: idempotencyKey.length,
        },
      }
    },
  }
}
