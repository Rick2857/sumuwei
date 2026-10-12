/**
 * 资讯阅读能力的登记（第二批计划 §3.3 / §4 能力影响矩阵）。
 *
 * ```text
 * news.read   news:read   R1  read
 * ```
 * 与 `web.read` 同为出站读，因此同样声明 `R1`（`read` 的下限是 `R0`，这是刻意抬高的一档）。
 *
 * ============================================================================
 *  它与 `web.read` 的边界（计划书 §3.3 第 2、4 点）
 * ============================================================================
 * ```text
 * news.read   取一个**订阅源**（RSS/Atom），产出**结构化条目**（标题/来源/发布时间/摘要）
 * web.read    取**一篇正文**并提取文章主体
 * ```
 * 计划书要求"任务要求深读某条时，任务执行环把该条链接交给现有 `web.read`"
 * ⇒ 深读**不新开能力**，也不让资讯适配器自己变成第二个网页抓取器。
 *
 * ⚠️ 一条刻意的取舍（计划书 §3.3 第 2 点）：解析用 `rss-parser.parseString()`，
 *    **不**用 `parseURL()` —— 后者自己处理网络、重定向与 60 秒缺省超时，
 *    那是"绕过 LG 的受限 HTTPS 获取器"的入口。网络那一侧只用既有获取器。
 */

import type { CapabilityDefinition } from './capability-registry.ts'

export const NEWS_READ = 'news.read'
export const NEWS_READ_OPERATION = 'read'
export const NEWS_READ_PERMISSION = 'news:read'

export const NEWS_CAPABILITY_IDS: readonly string[] = [NEWS_READ]

export function isNewsCapability(capabilityId: string): boolean {
  return NEWS_CAPABILITY_IDS.includes(capabilityId)
}

export function newsCapabilityLabel(capabilityId: string): string {
  return capabilityId === NEWS_READ ? '资讯阅读' : capabilityId
}

/** 首版运行约束（计划书 §3.3 逐字：单次最多 3 个订阅源、10 条候选、5 条交付资讯） */
export const NEWS_LIMITS = {
  maxFeeds: 3,
  maxCandidates: 10,
  maxDelivered: 5,
  /** 单个 feed 的响应体上限（与 `web.read` 的受限获取器同规） */
  maxFeedBytes: 2 * 1024 * 1024,
} as const

export function createNewsCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: NEWS_READ,
      version: `${NEWS_READ}@1`,
      description:
        '用 LG 的受限 HTTPS 获取器取回 RSS/Atom，再用固定版本的解析器转成结构化条目；' +
        '按发布时间与用户时间范围过滤、按链接去重。发布时间未知时如实标为未知。',
      operations: [
        {
          name: NEWS_READ_OPERATION,
          description: '取回一个或多个订阅源并返回有界条目集合',
          sideEffect: 'read',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [NEWS_READ_PERMISSION],
      supportsDryRun: true,
      // "重放上一次成功"会拿**旧条目**当**最新资讯**回答 —— 那是一次说错时间
      idempotency: 'none',
    },
  ]
}
