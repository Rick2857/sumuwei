/**
 * WebSearchAdapter —— `web.search` 的**能力适配器**（M5.5 WP3/WP4）。
 *
 * ============================================================================
 *  它是"provider 端口"与"M4.5 动作链"之间唯一的桥
 * ============================================================================
 * ```text
 * SearchProviderPort（不认识 M4.5）
 *        ↓  ← 本文件
 * AdapterOutcome{ effect, evidence(ActionEvidence[]), externalEvidence }
 *        ↓
 * ActionGateway（策略 / 账本 / 执行真相）→ ActionResult
 * ```
 *
 * 三条边界，逐条对应 ADR-045：
 * · **适配器不接收上下文**：`AdapterExecuteInput` 只有 `args/target/now`，
 *   没有记忆、prompt、人设、历史对话、userId、traceId 的位置（`D-3` / `D-19` §4）。
 * · **原始摘要只在当轮内存**：`AdapterOutcome.externalEvidence` 是内存载体；
 *   进账本的是 `ActionEvidence[]`，每条只带 **id / provider / 来源 / 时间 / 指纹 / 标签**
 *   （`D-8`）。**摘要正文一个字节都不落库。**
 * · **失败不许装成成功**：provider 的任何失败都原样抛出（`ActionFailureError`），
 *   由 Gateway 归一成受控失败码；"返回了条目但没有一条能形成证据"是 **partial**，
 *   不是 success（`D-8` 的同一精神：没成功就没成功口吻）。
 */

import type { Timestamp } from '../../../kernel/contracts/ids.ts'
import {
  buildExternalEvidenceList,
  toExternalEvidenceRefs,
  EVIDENCE_LIMITS,
  type ContentFingerprinter,
  type ExternalEvidence,
} from '../../../kernel/contracts/external-evidence.ts'
import { ActionFailureError, actionFailure } from '../../../kernel/action/errors.ts'
import type { ActionEvidence } from '../../../kernel/action/action-request.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { validateSearchQuery, type SearchProviderPort } from '../../../kernel/action/search-port.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_LOCALE,
  WEB_SEARCH,
  WEB_SEARCH_OPERATION,
} from '../../../kernel/action/external-evidence-capability.ts'

export interface WebSearchAdapterOptions {
  provider: SearchProviderPort
  /** 内容指纹（基础设施实现：`createSha256Fingerprinter()`） */
  fingerprint: ContentFingerprinter
  defaultLimit?: number
  defaultLocale?: string
}

function readLimit(args: Record<string, unknown>, fallback: number): number {
  const raw = args.limit
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return fallback
  return Math.min(Math.max(raw, EVIDENCE_LIMITS.minResultLimit), EVIDENCE_LIMITS.maxResultLimit)
}

export function createWebSearchAdapter(options: WebSearchAdapterOptions): CapabilityAdapter {
  const defaultLimit = options.defaultLimit ?? DEFAULT_SEARCH_LIMIT
  const defaultLocale = options.defaultLocale ?? DEFAULT_SEARCH_LOCALE

  return {
    capabilityId: WEB_SEARCH,

    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const query = (stringArg(input.args, 'query') ?? '').trim()
      const locale = (stringArg(input.args, 'locale') ?? defaultLocale).trim()
      const limit = readLimit(input.args, defaultLimit)

      /*
       * ① 请求合法性：**在发请求之前**失败关闭。
       *    "帮我不带搜索词地搜一下"必须是一次可审计的 `validation_failed`，
       *    而不是一次空查询的出海。
       */
      const problems = validateSearchQuery({ query, limit, locale })
      if (problems.length > 0) {
        throw new ActionFailureError(
          actionFailure('validation_failed', `这次搜索的请求不合法：${problems.join(' / ')}`, {
            capability: WEB_SEARCH,
            operation: WEB_SEARCH_OPERATION,
          })
        )
      }

      // ② 一次有界搜索（provider 自己保证"恰好一次请求 / 零重试 / 硬超时"）
      const outcome = await options.provider.search({ query, limit, locale })

      if (!outcome.ok) {
        // 失败原样抛出：timeout / validation_failed / permission_denied … 一个都不许被压成 success
        throw new ActionFailureError(outcome.failure)
      }

      // ③ 原始条目 → 证据（失败关闭 + 去重 + 稳定标签；**唯一**入口）
      const built = buildExternalEvidenceList({
        provider: options.provider.id,
        items: outcome.items,
        retrievedAt: input.now(),
        fingerprint: options.fingerprint,
      })
      const evidence: readonly ExternalEvidence[] = built.evidence
      const refs = toExternalEvidenceRefs(evidence)
      /** 丢弃总数 = provider 层丢弃 + 证据层拒绝（都**只计数**，不带正文） */
      const rejected = outcome.rejectedItems + built.rejections.length

      const actionEvidence: ActionEvidence[] = refs.map((ref) => ({
        kind: 'adapter',
        detail: `${options.provider.id} ${ref.citationLabel}`,
        ref: ref.id,
        // ⚠️ 只带引用（无 snippet）：这一条是"摘要不进账本"的结构性保证
        externalEvidence: ref,
      }))

      const head: ActionEvidence = {
        kind: 'adapter',
        detail:
          `搜索完成：${evidence.length} 条可用证据` +
          `${rejected > 0 ? `（另有 ${rejected} 条未形成证据）` : ''}` +
          (outcome.metrics ? `；模型请求 ${outcome.requestCount}，原生搜索 ${outcome.metrics.reportedSearchCalls ?? 'unknown'}，网页读取 ${outcome.metrics.sourceReads}，网页请求尝试 ${outcome.metrics.sourceRequestAttempts}，读取失败 ${outcome.metrics.failedSourceReads}` : ''),
        ref: options.provider.id,
      }

      /*
       * ④ 三种结局，区别是刻意的：
       *    · 有条目且形成了证据       → success
       *    · 有条目但一条都没形成证据 → **partial**（"查到了一些东西，但没有可引用的来源"）
       *    · 条目本来就是 0           → success + no_change（"查了，但没有结果"）
       */
      if (outcome.items.length > 0 && evidence.length === 0) {
        return {
          effect: { kind: 'no_change', detail: `search: ${options.provider.id}（0 条可引用）` },
          evidence: [head, ...actionEvidence],
          externalEvidence: [],
          partial: {
            completed: 0,
            total: outcome.items.length,
            detail: '返回的条目没有一条能形成证据（非 HTTPS / 缺字段 / 重复）',
          },
        }
      }

      return {
        ...(outcome.metrics && outcome.metrics.failedSourceReads > 0 ? {
          partial: { completed: evidence.length, total: outcome.items.length, detail: '部分来源正文未能读取' },
        } : {}),
        effect:
          evidence.length > 0
            ? {
                kind: 'content_read',
                detail: `search: ${options.provider.id}（${evidence.length} 条证据）`,
              }
            : { kind: 'no_change', detail: `search: ${options.provider.id}（无结果）` },
        evidence: [head, ...actionEvidence],
        externalEvidence: evidence,
      }
    },
  }
}

/** 便于诊断：一行说明（**不含 query、不含任何认证信息**） */
export function describeWebSearchAdapter(input: {
  providerId: string
  endpointHost: string
}): string {
  return `web.search adapter → ${input.providerId} @ ${input.endpointHost}（结果 ≤ ${EVIDENCE_LIMITS.maxResultLimit}）`
}

/** 便于其它模块断言"这条动作是不是搜索"（只有一处定义） */
export function isWebSearchRequest(capability: string): boolean {
  return capability === WEB_SEARCH
}

export type { ExternalEvidence, Timestamp }
