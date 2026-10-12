/**
 * 办公文件生成能力的登记（第二批计划 §3.2 / §4 能力影响矩阵）。
 *
 * ```text
 * office.generate   office:generate + local-file:write   R1  write
 * ```
 *
 * ============================================================================
 *  为什么它**同时**要 `local-file:write`
 * ============================================================================
 * 计划书 §4 的影响矩阵逐字写着 `office.generate` 的权限是
 * 「`office:generate` + `local-file:write`」。这不是冗余：
 * `office.generate` 说的是"允许调用三个 Python 库生成 Office 文件"，
 * `local-file:write` 说的是"允许写入**本机那一个具体文件**"。
 * 两件事分别可关：
 * ```text
 * 只关 local-file:write ⇒ 生成能力还在，但落不了盘 ⇒ 如实失败（不是静默改路径）
 * 只关 office:generate  ⇒ 本机写入还在（可用 local.file.write 写文本），但生成不了 Office
 * ```
 * 策略第 ③ 步要求**全部**声明权限都被授予，因此这两条边界是结构性生效的，
 * 不靠适配器自己记得检查。
 *
 * ============================================================================
 *  首版不接受的形状（计划书 §3.2 逐字）
 * ============================================================================
 * 「由模型提供**受限结构化内容**、可信模板和程序生成文件，
 *   **不接受模型生成 Python/Shell 代码直接运行**」。
 * ⇒ 适配器的参数里**没有** `code` / `script` 字段；内容是一份受限 JSON 规格，
 *    由本仓库固定版本的生成器脚本解释。模型能表达的是"标题/段落/表格/单元格"，
 *    不是"调用什么库、怎么写循环"。
 */

import type { CapabilityDefinition } from './capability-registry.ts'
import { LOCAL_FILE_WRITE_PERMISSION } from './local-file-capabilities.ts'

export const OFFICE_GENERATE = 'office.generate'
export const OFFICE_GENERATE_OPERATION = 'generate'
export const OFFICE_GENERATE_PERMISSION = 'office:generate'

/** 首版支持的三种格式（闭集；PDF 导出、宏、复杂模板修改都是后续切片） */
export const OFFICE_FORMATS = ['docx', 'xlsx', 'pptx'] as const
export type OfficeFormat = (typeof OFFICE_FORMATS)[number]

export const OFFICE_CAPABILITY_IDS: readonly string[] = [OFFICE_GENERATE]

export function isOfficeCapability(capabilityId: string): boolean {
  return OFFICE_CAPABILITY_IDS.includes(capabilityId)
}

export function officeCapabilityLabel(capabilityId: string): string {
  return capabilityId === OFFICE_GENERATE ? '办公文件生成' : capabilityId
}

export function createOfficeCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: OFFICE_GENERATE,
      version: `${OFFICE_GENERATE}@1`,
      description:
        '按一份**受限结构化规格**生成 DOCX / XLSX / PPTX 文件，生成后**重新打开**校验' +
        '指定文本、数字与结构，并报回实际路径与指纹。不接受任意代码执行。',
      operations: [
        {
          name: OFFICE_GENERATE_OPERATION,
          description: '按 spec（取自私有暂存）生成 format 指定的 Office 文件',
          sideEffect: 'write',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R1',
      // 两条权限都要（矩阵逐字）—— 生成 + 本机落盘是两件分别可关的事
      permissions: [OFFICE_GENERATE_PERMISSION, LOCAL_FILE_WRITE_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
  ]
}
