import type { CapabilityDefinition } from './capability-registry.ts'

/**
 * A1 / WP4：**管理控制台的写能力**（用户 2026-10-14 裁定走 ActionGateway）。
 *
 * ```text
 * 它**只**做一件事：把"一个待执行的后台任务"登记进 `admin_jobs`（`register`）。
 * · **不改任何领域数据**（记忆 / 目标 / 认知一律不碰）—— 这一点是"能进网关"的前提，
 *   也是它与"控制面命令"的本质区别（控制面按 STOP 条件 14 **只收只读命令**）。
 * · **幂等键必需**（`idempotency: 'required'`）：同键同参数返回原任务；同键不同参数明确拒绝。
 * · 参数闭集只有三个：`idempotencyKey` / `params` / `kind`—— 多一个键就**不是**这个能力。
 * ⚠️ `sideEffect: 'write'` 是**显式声明**：声明本身不构成许可，还要
 *   `WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS` 点名（`admin_job_admission`，契约的**两道** diff）。
 * ⚠️ 今天**没有执行器**去跑登记出来的任务 ⇒ 它们停在 `pending`；那是**如实**状态，不是故障。
 * ```
 */
export const ADMIN_JOBS_ADMIT = 'admin.jobs.admit'
export const ADMIN_JOBS_ADMIT_PERMISSION = 'admin:jobs_admit'

export function createAdminJobsCapabilities(): readonly CapabilityDefinition[] {
  return [{
    id: ADMIN_JOBS_ADMIT,
    version: `${ADMIN_JOBS_ADMIT}@1`,
    description: '在管理控制台登记一个后台任务（只写 admin_jobs 的登记行，不改领域数据）。',
    operations: [{
      name: 'register',
      description: '登记一个待执行任务；同一幂等键重复提交返回原任务',
      sideEffect: 'write',
      riskLevel: 'R2',
    }],
    sideEffectLevel: 'write',
    riskLevel: 'R2',
    permissions: [ADMIN_JOBS_ADMIT_PERMISSION],
    supportsDryRun: false,
    idempotency: 'required',
  }]
}
