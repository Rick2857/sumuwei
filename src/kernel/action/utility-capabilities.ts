/**
 * 四项实用能力的**登记**（实用能力加装计划 §2 第 5 点 / §4 能力影响矩阵）。
 *
 * ============================================================================
 *  与 `web.search` 同一种结构（先例 ADR-045 `D-11`/`D-12`）
 * ============================================================================
 * 1. **独立工厂**，不并入 `createDefaultCapabilityDefinitions()`：
 *    M4.5 的既有判据锁着"默认集 = 3 个能力"，改它就是改已冻结的 M4.5 判据
 *    ⇒ 这里只做**追加**，装配层显式拼 `[...默认集, ...外部证据, ...本文件]`。
 * 2. **能力恒登记、权限条件授予**：
 *    能力一直在登记表里（于是关闭时用户显式要求会得到一条**可审计的
 *    `permission_denied`**，模型据此如实说"没启用"，而不是"装作没听懂"），
 *    但权限**只在对应开关打开时**授予，适配器也只在那一刻构造
 *    ⇒ flag 关闭时**构造上**没有执行器、没有出站、不加载重依赖。
 * 3. **`idempotency: 'none'`**：账本只存引用、不存正文；若声明支持幂等，
 *    "重放上一次成功"会产出"成功了但没有内容"的假象 —— 那比一次诚实的失败更坏。
 *
 * ============================================================================
 *  风险等级：四项都是 `read`，但**不是同一个 R 档**
 * ============================================================================
 * ```text
 * math.calculate   R0  none   它在本地算一个数，不读任何外部资源
 * document.read    R0  read   读沙箱内的一个文件（范围由既有沙箱边界守）
 * image.ocr        R0  read   读沙箱内的一个图片（同上）
 * web.read         R1  read   读**外部世界**的任意公网地址（出站，故比本地读高一档）
 * ```
 * `read` 的风险下限是 `R0`，因此 `web.read` 声明 `R1` 合法且是被刻意抬高的那一档
 * （先例：`web.search` 也是 `R1`）。
 */

import type { CapabilityDefinition } from './capability-registry.ts'

export const MATH_CALCULATE = 'math.calculate'
export const MATH_CALCULATE_OPERATION = 'evaluate'
export const MATH_CALCULATE_PERMISSION = 'math:calculate'

export const DOCUMENT_READ = 'document.read'
export const DOCUMENT_READ_OPERATION = 'read'
export const DOCUMENT_READ_PERMISSION = 'document:read'

export const WEB_READ = 'web.read'
export const WEB_READ_OPERATION = 'read'
export const WEB_READ_PERMISSION = 'web:read'

export const IMAGE_OCR = 'image.ocr'
export const IMAGE_OCR_OPERATION = 'recognize'
export const IMAGE_OCR_PERMISSION = 'image:ocr'

/** 四项能力的 id（顺序 = 计划书的实现顺序：计算 → 文档 → 网页 → OCR） */
export const UTILITY_CAPABILITY_IDS: readonly string[] = [
  MATH_CALCULATE,
  DOCUMENT_READ,
  WEB_READ,
  IMAGE_OCR,
]

export function isUtilityCapability(capabilityId: string): boolean {
  return UTILITY_CAPABILITY_IDS.includes(capabilityId)
}

/** 用户可读的能力名（开发者面与回复层共用一处，避免两处各写一遍） */
export function utilityCapabilityLabel(capabilityId: string): string {
  switch (capabilityId) {
    case MATH_CALCULATE:
      return '精确计算'
    case DOCUMENT_READ:
      return '文档阅读'
    case WEB_READ:
      return '网页深读'
    case IMAGE_OCR:
      return '图片识别'
    default:
      return capabilityId
  }
}

/**
 * 四项能力的登记声明。
 *
 * ⚠️ `permissions` 非空（登记表拒绝"不需要权限"这种留空表达），
 *    因此"flag 关闭 = 不授予"这条边界恰好落在策略的第 ③ 步。
 */
export function createUtilityCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: MATH_CALCULATE,
      version: `${MATH_CALCULATE}@1`,
      description:
        '对用户给出的**受限算式**做一次精确计算（受限 AST + 白名单函数 + 硬上限），' +
        '结果作为当轮内容返回（不写长期记忆，不执行任意程序）。',
      operations: [
        {
          name: MATH_CALCULATE_OPERATION,
          description: '把 expression 交给受限计算器求值',
          sideEffect: 'none',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'none',
      riskLevel: 'R0',
      permissions: [MATH_CALCULATE_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: DOCUMENT_READ,
      version: `${DOCUMENT_READ}@1`,
      description:
        '读取沙箱内一个文档（PDF / DOCX / PPTX / XLSX / 纯文本）的**正文**，' +
        '并把实际取得的文字作为当轮内容返回（不写长期记忆）。',
      operations: [
        {
          name: DOCUMENT_READ_OPERATION,
          description: '把 path 指向的文件交给独立转换环境提取文字',
          sideEffect: 'read',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R0',
      permissions: [DOCUMENT_READ_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: WEB_READ,
      version: `${WEB_READ}@1`,
      description:
        '按用户显式给出的 HTTPS 地址做一次**有界获取**并提取文章正文，' +
        '作为当轮内容返回（不写长期记忆；不执行页面脚本、不加载子资源）。',
      operations: [
        {
          name: WEB_READ_OPERATION,
          description: '把 url 指向的静态文章正文取回来',
          sideEffect: 'read',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [WEB_READ_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: IMAGE_OCR,
      version: `${IMAGE_OCR}@1`,
      description:
        '读取沙箱内一个 PNG / JPEG 图片并做**本地**文字识别（语言资产固定在本地），' +
        '把识别文字与引擎读数作为当轮内容返回（不写长期记忆）。',
      operations: [
        {
          name: IMAGE_OCR_OPERATION,
          description: '把 path 指向的图片字节交给本地 OCR 执行器',
          sideEffect: 'read',
          riskLevel: 'R0',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R0',
      permissions: [IMAGE_OCR_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
  ]
}
