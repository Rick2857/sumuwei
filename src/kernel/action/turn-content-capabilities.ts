/**
 * "哪些能力会产出当轮内容"的**唯一清单**（第二批）。
 *
 * ============================================================================
 *  为什么需要一个聚合清单，而不是各能力各判各的
 * ============================================================================
 * 回复守卫（`turn-content-reply.ts`）必须回答两个问题：
 * ```text
 * ① 这一轮的动作里，哪些是"会产出当轮内容"的能力？（决定要不要接管回复）
 * ② 那个能力的产物是哪一种 kind？（决定"我读了 / 我算出来了"该怎么如实说）
 * ```
 * 第一批的答案是 `UTILITY_CAPABILITY_IDS`（四项），写在 `utility-capabilities.ts` 里 ——
 * 那个文件的名字与注释都已经冻结在"第一批四项"的语义上。
 * 第二批**不改它**，而是把"清单"与"kind 映射"抽到这里，两批共用一处。
 *
 * ⚠️ 这张表必须随新增能力**同步追加**：一个会产出 `TurnContent` 的能力如果不在表里，
 *    它产出的正文会被上下文注入（section 只按 `turnContent` 字段走），
 *    但回复守卫**不会**为它兜底 —— 于是"读到了正文"与"能如实说"之间出现缺口。
 *    本批的公共验收组有一条专门查这个缺口（"清单完整性"）。
 */

import type { TurnContentKind } from '../contracts/turn-content.ts'
import {
  DOCUMENT_READ,
  IMAGE_OCR,
  MATH_CALCULATE,
  UTILITY_CAPABILITY_IDS,
  WEB_READ,
  utilityCapabilityLabel,
} from './utility-capabilities.ts'
import {
  LOCAL_FILE_LIST,
  LOCAL_FILE_READ,
  localFileCapabilityLabel,
} from './local-file-capabilities.ts'
import { WEATHER_QUERY, weatherCapabilityLabel } from './weather-capability.ts'
import { XIDIAN_TIMETABLE } from './xidian-capability.ts'
import { OFFICE_GENERATE, officeCapabilityLabel } from './office-capability.ts'
import { NEWS_READ, newsCapabilityLabel } from './news-capability.ts'
import { BROWSER_READ, browserCapabilityLabel } from './browser-capability.ts'
import { DESKTOP_INSPECT, desktopCapabilityLabel } from './desktop-capability.ts'
import { PERSONAL_LIBRARY_SEARCH, ARXIV_RESEARCH } from './learning-capabilities.ts'

/**
 * 会产出当轮内容的能力全集。
 *
 * 顺序 = 实现顺序（第一批四项 → 本批文件域 → 天气 → 办公 → 资讯 → 浏览器）。
 *
 * ⚠️ **`local.file.write` 与 `browser.operate` 刻意不在表里**，尽管它们确实会
 *    改变世界：它们**不承诺产出正文**，因此"成功但没有内容"对它们**不是**异常状态。
 *    把它们放进来会让回复守卫把一句正确的"我写好了"改写成
 *    "我打开看了，但这次没有取到可以引用的内容" —— 那是**用一个假话换掉一个真话**。
 *    它们的"说了做过"由既有的 `applyActionClaimGuard`（以执行结果为键）负责，
 *    那是 M4.5 就已经冻结的那道守卫。
 */
export const TURN_CONTENT_CAPABILITY_IDS: readonly string[] = [
  ...UTILITY_CAPABILITY_IDS,
  LOCAL_FILE_LIST,
  LOCAL_FILE_READ,
  WEATHER_QUERY,
  XIDIAN_TIMETABLE,
  OFFICE_GENERATE,
  NEWS_READ,
  BROWSER_READ,
  /*
   * ADR-106：**桌面的"看一次"**会产出当轮正文（窗口 + 控件）。
   * ⚠️ 刻意**不含** `desktop.operate`：与 `browser.operate` 同一条理由 ——
   *    它不承诺"一定有内容"，进去会把一次正确的"我点了"改写成
   *    "我打开看了，但这次没有取到可以引用的内容"（用一个假话换掉一个真话）。
   */
  DESKTOP_INSPECT,
  PERSONAL_LIBRARY_SEARCH,
  'project.search',
  'self.capabilities',
  ARXIV_RESEARCH,
  'document.extract',
  'document.profile',
  'document.pages',
]

export function producesTurnContent(capabilityId: string): boolean {
  return TURN_CONTENT_CAPABILITY_IDS.includes(capabilityId)
}

/**
 * 能力 → 它产出的 `TurnContentKind`。
 *
 * ⚠️ 缺省 `'local-text'` 而不是 `'document'`：两批合起来看，"未知能力"更可能来自
 *    本机文件域（第二批），而 `'document'` 的具体形状（`structure[]`）在
 *    `TurnContentFact` 里并不需要 —— `kind` 只用于措辞分支。
 *    `utility-capabilities.ts` 里原来那个 `default: return 'document'` 的取舍
 *    在这里被显式写出来（第一批四项都在表里，因此旧路径的取值**逐字不变**）。
 */
export function turnContentKindOfCapability(capabilityId: string): TurnContentKind {
  switch (capabilityId) {
    case MATH_CALCULATE:
      return 'calculation'
    case DOCUMENT_READ:
    case 'document.extract':
    case 'document.profile':
    case 'document.pages':
      return 'document'
    case WEB_READ:
      return 'web-article'
    case IMAGE_OCR:
      return 'ocr'
    case LOCAL_FILE_LIST:
    case LOCAL_FILE_READ:
    case WEATHER_QUERY:
    case NEWS_READ:
    case BROWSER_READ:
      return 'local-text'
    case OFFICE_GENERATE:
      return 'document'
    case DESKTOP_INSPECT:
      return 'desktop-state'
    default:
      return 'local-text'
  }
}

/**
 * 用户可读的能力名。
 *
 * ⚠️ 第一批四项**继续**走 `utilityCapabilityLabel()` —— 不在这里重写一遍，
 *    否则同一个能力会有两个措辞来源，而它们迟早会分叉。
 */
export function turnContentCapabilityLabel(capabilityId: string): string {
  if (capabilityId === XIDIAN_TIMETABLE) return '西电本科课表查询'
  if (capabilityId === 'document.extract') return 'PDF 正文提取'
  if (capabilityId === 'document.profile') return 'PDF 结构检查'
  if (capabilityId === 'document.pages') return 'PDF 指定页读取'
  if (capabilityId === PERSONAL_LIBRARY_SEARCH) return '个人资料夹检索'
  if (capabilityId === 'project.search') return '项目资料检索'
  if (capabilityId === 'self.capabilities') return '当前实例能力查询'
  if (capabilityId === ARXIV_RESEARCH) return 'arXiv 论文查阅'
  if (UTILITY_CAPABILITY_IDS.includes(capabilityId)) {
    return utilityCapabilityLabel(capabilityId)
  }
  if (capabilityId.startsWith('local.file.')) return localFileCapabilityLabel(capabilityId)
  if (capabilityId === WEATHER_QUERY) return weatherCapabilityLabel(capabilityId)
  if (capabilityId === OFFICE_GENERATE) return officeCapabilityLabel(capabilityId)
  if (capabilityId === NEWS_READ) return newsCapabilityLabel(capabilityId)
  if (capabilityId.startsWith('browser.')) return browserCapabilityLabel(capabilityId)
  if (capabilityId === DESKTOP_INSPECT) return desktopCapabilityLabel(capabilityId)
  return capabilityId
}
