/**
 * `web.search` —— 联网搜索能力的**登记**（M5.5 / ADR-045 `D-4`·`D-11`·`D-12`·`D-13`）。
 *
 * ============================================================================
 *  三条刻意的结构决定
 * ============================================================================
 * 1. **独立工厂**，不并入 `createDefaultCapabilityDefinitions()`
 *    （`D-11`）：M4.5 的既有判据锁着"默认集 = 3 个能力"
 *    （`scripts/kernel-tests-action.ts` 的 §2.1）。改它就是改 M4.5 的判据，
 *    而 M4.5 已冻结验收 ⇒ 这里只做**追加**：装配层显式拼
 *    `[...默认集, ...本文件的能力]`。
 * 2. **能力恒登记、权限条件授予**（`D-12`）：
 *    能力一直在登记表里，但 `web:search` 这条权限**只在 `CHARACTER_WEB_SEARCH_ENABLED=true`
 *    时**由装配层授予，适配器也只在那一刻构造。于是 flag 关闭时用户说"搜一下"
 *    得到的是**可审计的 `permission_denied`**（→ 模型能如实说"联网没启用"），
 *    而不是"装作没听懂"；同时没有适配器 ⇒ **构造上无法联网**。
 * 3. **`idempotency: 'none'`**（`D-13`）：账本按 `D-8` 只存引用、不存正文；
 *    若声明支持幂等，"重放上一次成功"会产出"成功了但没有内容"的假象 ——
 *    那比一次诚实的失败更坏。每一次显式搜索都是一次新的读。
 *
 * `sideEffect = 'read'` + `riskLevel = 'R1'`：它读外部世界、不改它；
 * `read` 的风险下限是 `R0`，声明 `R1` 合法，且仍受 `CHARACTER_ACTION_MAX_RISK` 约束。
 */

import type { CapabilityDefinition } from './capability-registry.ts'
import { EVIDENCE_LIMITS } from '../contracts/external-evidence.ts'

export const WEB_SEARCH = 'web.search'
export const WEB_SEARCH_OPERATION = 'search'
export const WEB_SEARCH_PERMISSION = 'web:search'

/**
 * 默认查询语言标签。
 *
 * ⚠️ 如实登记：它目前是**常量**，不是从上下文推断出来的 —— 运行时没有"用户语言"这个输入
 *    （M5 的 `RecallRequest.intent` 恒为 `current_fact`，也没有 locale）。
 *    而本地 SearXNG 只接受它自己 `locales` 列表里的代码，`zh-CN` **不在**其中
 *    ⇒ 会被实例回落到默认语言（ADR-047 的已知弱化 1）。
 *    它**不**假装生效，也不影响合规性（`language` 只是排序增强）。
 */
export const DEFAULT_SEARCH_LOCALE = 'zh-CN'

/** 一次搜索默认取几条（硬上限见 `EVIDENCE_LIMITS.maxResultLimit`） */
export const DEFAULT_SEARCH_LIMIT = EVIDENCE_LIMITS.defaultResultLimit

/**
 * M5.5 的能力声明。
 *
 * ⚠️ `permissions` **必须**非空（登记表拒绝"不需要权限"这种留空表达），
 *    因此"flag 关闭 = 不授予"这条边界恰好落在策略的第 ③ 步。
 */
export function createExternalEvidenceCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: WEB_SEARCH,
      version: `${WEB_SEARCH}@1`,
      description:
        '按用户显式要求做一次有界联网搜索，并把结果作为**当轮外部证据**返回（不写长期记忆）。',
      operations: [
        {
          name: WEB_SEARCH_OPERATION,
          description: `把 query 交给已配置的本地搜索服务（结果 ≤ ${EVIDENCE_LIMITS.maxResultLimit} 条）`,
          sideEffect: 'read',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [WEB_SEARCH_PERMISSION],
      supportsDryRun: true,
      /*
       * 'none' 是刻意的（D-13）：见文件头第 3 条。
       * 记账本只存引用，重放会产出"成功了但没有内容"。
       */
      idempotency: 'none',
    },
  ]
}

/** 这一个能力是不是 M5.5 的外部证据能力（用于"它是不是搜索"这类判断只有一处） */
export function isExternalEvidenceCapability(capabilityId: string): boolean {
  return capabilityId === WEB_SEARCH
}
