/**
 * 本机文件域的三个能力登记（第二批计划 §2.1 / §4 能力影响矩阵）。
 *
 * ============================================================================
 *  它与 `sandbox.file.*` 是**并存的两套**，不是替换
 * ============================================================================
 * 计划书 §2.1 第 1 点逐字：「新增具名 `local.file.list/read/write`，分别授予
 * `local-file:list/read/write`…**旧 `sandbox.file.*` 及其根内判据保留**，
 * 避免改根目录或删除旧守卫造成全部旧用例含义改变」。
 *
 * 因此：
 * ```text
 * sandbox.file.read/write  能力恒登记、权限在 DEFAULT_GRANTED_PERMISSIONS 里 —— 逐字不变
 * local.file.list/read     能力**恒登记**、权限**只在开关打开时**授予
 * local.file.write         同上；它还有第二个前提：目标必须是"已授权的任务内目标"
 * ```
 *
 * ============================================================================
 *  风险与副作用（与第一批四项同一条推理链）
 * ============================================================================
 * ```text
 * local.file.list   R0  read   枚举一个真实目录（读操作；不改变世界）
 * local.file.read   R0  read   读一个真实文件的字节（读操作）
 * local.file.write  R1  write  创建 / 修改 / 覆盖本机文件（**本地可回滚写**）
 * ```
 * `read` 的风险下限是 `R0` ⇒ 前两项合法；`write` 的下限是 `R1` ⇒ 第三项合法。
 * 三个能力都声明 `idempotency: 'none'`，与第一批四项同一条理由：
 * 账本只存引用、不存正文；若声明幂等，"重放上一次成功"会产出
 * "成功了但没有内容"的假象 —— 那比一次诚实的失败更坏。
 * 尤其对 `write`：幂等键是按 `arguments` 算的，而写入载荷在参数里是**引用**
 * （见 `payload-staging.ts`），重放一个引用并不能重放一次真实的字节相同写入。
 */

import type { CapabilityDefinition } from './capability-registry.ts'

export const LOCAL_FILE_LIST = 'local.file.list'
export const LOCAL_FILE_LIST_OPERATION = 'list'
export const LOCAL_FILE_LIST_PERMISSION = 'local-file:list'

export const LOCAL_FILE_READ = 'local.file.read'
export const LOCAL_FILE_READ_OPERATION = 'read'
export const LOCAL_FILE_READ_PERMISSION = 'local-file:read'

export const LOCAL_FILE_WRITE = 'local.file.write'
export const LOCAL_FILE_WRITE_OPERATION = 'write'
export const LOCAL_FILE_WRITE_PERMISSION = 'local-file:write'

/** 本机文件域的三个能力 id（顺序 = 只读 → 只读 → 写） */
export const LOCAL_FILE_CAPABILITY_IDS: readonly string[] = [
  LOCAL_FILE_LIST,
  LOCAL_FILE_READ,
  LOCAL_FILE_WRITE,
]

export function isLocalFileCapability(capabilityId: string): boolean {
  return LOCAL_FILE_CAPABILITY_IDS.includes(capabilityId)
}

/** 需要 `write` 副作用的那一个（"任务授权内目标"闸只对它生效） */
export function isLocalFileWriteCapability(capabilityId: string): boolean {
  return capabilityId === LOCAL_FILE_WRITE
}

/** 用户可读的能力名（开发者面与回复层共用一处） */
export function localFileCapabilityLabel(capabilityId: string): string {
  switch (capabilityId) {
    case LOCAL_FILE_LIST:
      return '本机目录列举'
    case LOCAL_FILE_READ:
      return '本机文件读取'
    case LOCAL_FILE_WRITE:
      return '本机文件写入'
    default:
      return capabilityId
  }
}

/**
 * 三个能力的登记声明。
 *
 * ⚠️ `permissions` 非空（登记表拒绝"不需要权限"这种留空表达）⇒
 *    "开关关闭 = 不授予"这条边界恰好落在策略的第 ③ 步，
 *    于是关闭时用户显式要求得到的是**一条可审计的 `permission_denied`**，
 *    而不是"装作没听懂"（先例 ADR-045 `D-12`）。
 */
export function createLocalFileCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: LOCAL_FILE_LIST,
      version: `${LOCAL_FILE_LIST}@1`,
      description:
        '枚举本机一个真实目录下的条目（分页、有上限），名字与类型作为当轮内容返回。' +
        '不读文件正文，不改变任何东西；网络共享与设备路径一律拒绝。',
      operations: [
        {
          name: LOCAL_FILE_LIST_OPERATION,
          description: '列出 directory 下的条目（按名字排序、有上限）',
          sideEffect: 'read',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R0',
      permissions: [LOCAL_FILE_LIST_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: LOCAL_FILE_READ,
      version: `${LOCAL_FILE_READ}@1`,
      description:
        '读取本机一个真实文件的字节，**文本类文件**的正文作为当轮内容返回。' +
        '二进制/文档/图片不在这里解释（那属于 `document.read` / `image.ocr`），' +
        '这里如实说"这个入口不解释这种格式"。',
      operations: [
        {
          name: LOCAL_FILE_READ_OPERATION,
          description: '读出 path 的字节（文本类返回正文；二进制返回如实的不支持）',
          sideEffect: 'read',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R0',
      permissions: [LOCAL_FILE_READ_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: LOCAL_FILE_WRITE,
      version: `${LOCAL_FILE_WRITE}@1`,
      description:
        '在本机创建 / 修改 / 覆盖一个真实文件。写入载荷经**私有暂存**传递，' +
        '覆盖前留下恢复副本并做并发修改检查；账本只收载荷引用与前后指纹。',
      operations: [
        {
          name: LOCAL_FILE_WRITE_OPERATION,
          description: '把暂存载荷写入 path（覆盖前留恢复副本 + 指纹比对）',
          sideEffect: 'write',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R1',
      permissions: [LOCAL_FILE_WRITE_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
  ]
}
