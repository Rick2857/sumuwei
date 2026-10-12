/**
 * CapabilityRegistry —— **能力必须登记才存在**（M4.5 §11 / ADR-031）。
 *
 * ============================================================================
 *  为什么"登记"本身要写这么多校验
 * ============================================================================
 * 登记口是"这个能力存在"的唯一来源。如果它能接受一份自相矛盾的声明，
 * 那么这份矛盾会一路传到策略、账本与回复层：
 *
 *   · 声明 `sideEffect=none` 却真的删文件 → 目标确定性闸被绕过
 *   · 声明 R1 却做 destructive 的事 → 风险上限被绕过
 *   · 声明 `destructive` 且 `idempotency=none` → 重试就重复破坏
 *
 * 因此**声明不合法 = 能力不存在**（fail-closed）。
 * 这与 M4 的放行口（`validator.ts`）是同一种设计：错误在入口就被拒绝，
 * 而不是等到执行的那一刻。
 */

import type { RiskLevel, SideEffectLevel } from './action-request.ts'
import { RISK_LEVELS, riskFloorOf, riskRank } from './action-request.ts'

export type IdempotencySupport = 'none' | 'supported' | 'required'

export interface OperationDefinition {
  /** 操作名，如 `read` / `write` / `echo` */
  name: string
  description: string
  sideEffect: SideEffectLevel
  riskLevel: RiskLevel
}

export interface CapabilityDefinition {
  /** 能力 id，如 `sandbox.file.write` */
  id: string
  version: string
  description: string
  operations: readonly OperationDefinition[]
  /** 该能力**所有**操作里的最高副作用等级 */
  sideEffectLevel: SideEffectLevel
  /** 该能力**所有**操作里的最高风险等级 */
  riskLevel: RiskLevel
  /** 执行它需要哪些权限（装配层显式授予，见 `DEFAULT_GRANTED_PERMISSIONS`） */
  permissions: readonly string[]
  supportsDryRun: boolean
  idempotency: IdempotencySupport
}

export interface RegistryProblem {
  code: string
  message: string
}

export interface CapabilityRegistry {
  get(id: string): CapabilityDefinition | undefined
  getOperation(capabilityId: string, operation: string): OperationDefinition | undefined
  has(id: string): boolean
  list(): readonly CapabilityDefinition[]
}

const SIDE_EFFECT_RANK: Record<SideEffectLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
}

export function sideEffectRank(level: SideEffectLevel): number {
  return SIDE_EFFECT_RANK[level]
}

export function maxSideEffect(levels: readonly SideEffectLevel[]): SideEffectLevel {
  let best: SideEffectLevel = 'none'
  for (const level of levels) {
    if (SIDE_EFFECT_RANK[level] > SIDE_EFFECT_RANK[best]) best = level
  }
  return best
}

export function maxRiskLevel(levels: readonly RiskLevel[]): RiskLevel {
  let best: RiskLevel = 'R0'
  for (const level of levels) {
    if (riskRank(level) > riskRank(best)) best = level
  }
  return best
}

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/

/**
 * 校验一份能力声明。
 *
 * 返回**全部**问题（而不是第一个）—— 一次修完比逐个报错省事，
 * 而且"哪些字段自相矛盾"本身就说明登记的人没想清风险。
 */
export function validateCapabilityDefinition(definition: CapabilityDefinition): RegistryProblem[] {
  const problems: RegistryProblem[] = []

  if (!ID_PATTERN.test(definition.id)) {
    problems.push({ code: 'invalid_id', message: `能力 id 不合法：${definition.id}` })
  }
  if (definition.version.trim() === '') {
    problems.push({ code: 'missing_version', message: `${definition.id} 缺少 version` })
  }
  if (definition.description.trim() === '') {
    problems.push({ code: 'missing_description', message: `${definition.id} 缺少 description` })
  }
  if (definition.operations.length === 0) {
    problems.push({ code: 'no_operations', message: `${definition.id} 没有声明任何 operation` })
  }
  if (definition.permissions.length === 0) {
    problems.push({
      code: 'no_permissions',
      message: `${definition.id} 没有声明 permissions —— "不需要权限"必须由策略显式表达，而不是留空`,
    })
  }

  const seen = new Set<string>()
  for (const operation of definition.operations) {
    if (!ID_PATTERN.test(operation.name)) {
      problems.push({
        code: 'invalid_operation',
        message: `${definition.id} 的 operation 名不合法：${operation.name}`,
      })
    }
    if (seen.has(operation.name)) {
      problems.push({
        code: 'duplicate_operation',
        message: `${definition.id} 重复声明 operation：${operation.name}`,
      })
    }
    seen.add(operation.name)

    if (riskRank(operation.riskLevel) < riskRank(riskFloorOf(operation.sideEffect))) {
      problems.push({
        code: 'risk_below_floor',
        message:
          `${definition.id}.${operation.name} 声明 sideEffect=${operation.sideEffect} ` +
          `却只给了 ${operation.riskLevel} —— 副作用等级决定了风险下限，` +
          `声明低于下限等于绕过风险上限`,
      })
    }
  }

  const declaredSideEffect = maxSideEffect(definition.operations.map((o) => o.sideEffect))
  if (declaredSideEffect !== definition.sideEffectLevel) {
    problems.push({
      code: 'side_effect_mismatch',
      message:
        `${definition.id} 的 sideEffectLevel=${definition.sideEffectLevel} ` +
        `与 operations 的最高等级 ${declaredSideEffect} 不一致`,
    })
  }

  const declaredRisk = maxRiskLevel(definition.operations.map((o) => o.riskLevel))
  if (declaredRisk !== definition.riskLevel) {
    problems.push({
      code: 'risk_mismatch',
      message: `${definition.id} 的 riskLevel=${definition.riskLevel} 与 operations 的最高等级 ${declaredRisk} 不一致`,
    })
  }

  if (riskRank(definition.riskLevel) < riskRank(riskFloorOf(definition.sideEffectLevel))) {
    problems.push({
      code: 'capability_risk_below_floor',
      message: `${definition.id} 的整体风险等级低于其副作用等级的下限`,
    })
  }

  if (definition.sideEffectLevel === 'destructive' && definition.idempotency === 'none') {
    problems.push({
      code: 'destructive_without_idempotency',
      message: `${definition.id} 是 destructive 却没有声明幂等 —— 重试即重复破坏`,
    })
  }

  return problems
}

/**
 * 建立登记表。
 *
 * 任何不合法或重复的声明都会**抛错**：登记表不存在"带着问题的部分可用"状态。
 */
export function createCapabilityRegistry(
  definitions: readonly CapabilityDefinition[]
): CapabilityRegistry {
  const byId = new Map<string, CapabilityDefinition>()
  const problems: RegistryProblem[] = []

  for (const definition of definitions) {
    problems.push(...validateCapabilityDefinition(definition))
    if (byId.has(definition.id)) {
      problems.push({ code: 'duplicate_capability', message: `重复登记能力：${definition.id}` })
    }
    byId.set(definition.id, definition)
  }

  if (problems.length > 0) {
    throw new Error(
      `CapabilityRegistry 声明不合法：\n` +
        problems.map((p) => `  ${p.code}: ${p.message}`).join('\n')
    )
  }

  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    getOperation: (capabilityId, operation) =>
      byId.get(capabilityId)?.operations.find((o) => o.name === operation),
    list: () => [...byId.values()],
  }
}

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

export const ECHO_PERMISSION = 'system:echo'
export const SANDBOX_READ_PERMISSION = 'sandbox:read'
export const SANDBOX_WRITE_PERMISSION = 'sandbox:write'

/**
 * 装配层的**显式**授权清单。
 *
 * ⚠️ 刻意不是"自动授予所有已登记能力"：那样以后新增一个能力
 *    会**自动获得权限**，而"新能力默认没有权限"才是安全的方向。
 */
export const DEFAULT_GRANTED_PERMISSIONS: readonly string[] = [
  ECHO_PERMISSION,
  SANDBOX_READ_PERMISSION,
  SANDBOX_WRITE_PERMISSION,
]

// ---------------------------------------------------------------------------
// 首批能力（M4.5 §15）
// ---------------------------------------------------------------------------

export const SYSTEM_ECHO = 'system.echo'
export const SANDBOX_FILE_READ = 'sandbox.file.read'
export const SANDBOX_FILE_WRITE = 'sandbox.file.write'

/**
 * M4.5 的首批能力。
 *
 * 计划书 §15 只允许低风险测试能力，§16 明确禁止 shell / HTTP /
 * 真实删除 / 消息 / 浏览器 / 调度 / 支付 / 多 Agent。
 *
 * ⚠️ R2 / R3 的等级**定义**已经存在（`RiskLevel`），但没有一个能力
 *    声明它们 —— 因此 R2/R3 **无法被执行**，而不是"执行了又被拒"。
 */
export function createDefaultCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: SYSTEM_ECHO,
      version: 'system.echo@1',
      description: '原样返回给定文本。无副作用，用于验证链路本身。',
      operations: [
        {
          name: 'echo',
          description: '把 text 原样返回',
          sideEffect: 'none',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'none',
      riskLevel: 'R0',
      permissions: [ECHO_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: SANDBOX_FILE_READ,
      version: 'sandbox.file.read@1',
      description: '读取沙箱根目录内的一个文件。范围外一律拒绝。',
      operations: [
        {
          name: 'read',
          description: '读出 path 的 UTF-8 内容',
          sideEffect: 'read',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R0',
      permissions: [SANDBOX_READ_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: SANDBOX_FILE_WRITE,
      version: 'sandbox.file.write@1',
      description: '在沙箱根目录内创建/覆盖一个文件。范围外一律拒绝。',
      operations: [
        {
          name: 'write',
          description: '把 content 写入 path（UTF-8）',
          sideEffect: 'write',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R1',
      permissions: [SANDBOX_WRITE_PERMISSION],
      supportsDryRun: true,
      idempotency: 'supported',
    },
  ]
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  return createCapabilityRegistry(createDefaultCapabilityDefinitions())
}

/** 供诊断输出：一行一条能力（`RISK_LEVELS` 用于确认等级枚举没被改坏） */
export function describeCapability(definition: CapabilityDefinition): string {
  const ops = definition.operations.map((o) => `${o.name}(${o.riskLevel}/${o.sideEffect})`).join(', ')
  return (
    `${definition.id}@${definition.version.replace(`${definition.id}@`, '')} ` +
    `[${definition.riskLevel}/${definition.sideEffectLevel}] ` +
    `ops=[${ops}] perms=[${definition.permissions.join(' ')}] ` +
    `idempotency=${definition.idempotency}`
  )
}

export { RISK_LEVELS }
