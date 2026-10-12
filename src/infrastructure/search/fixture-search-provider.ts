/**
 * FixtureSearchProvider —— **离线、确定性、可计数**的搜索 provider（M5.5 WP3）。
 *
 * ============================================================================
 *  它存在的理由有三个，每个都对应一条门
 * ============================================================================
 * 1. **离线**：整条链（契约 → provider → 证据构造 → 渲染）不碰网络也能跑完，
 *    因此 `pnpm m5.5:measurement:verify` 不需要 key、不需要联网、不会花钱。
 * 2. **可计数**：`callCount()` / `calls()` 是"**这一轮到底有没有联网**"的证据。
 *    没有显式搜索词的那一轮，这个数必须是 0 —— 而"0 次调用"与"没检查"
 *    在输出上必须能区分（所以它是一个**读得到的数**，不是一句断言）。
 * 3. **可注入任意形状**：空结果 / 超时 / 解析失败 / 非 HTTPS 条目 /
 *    带 prompt injection 的摘要 —— 负控需要它们，而真实 provider 不可能按需提供。
 *
 * ⚠️ 它**不**构造证据、**不**算指纹、**不**做去重与标签：那些是 kernel 契约层的活。
 *    这里返回的 `items` 是**未验证**的原始条目（`SearchEvidenceItem`）。
 */

import type { SearchEvidenceItem } from '../../kernel/contracts/external-evidence.ts'
import { actionFailure } from '../../kernel/action/errors.ts'
import type {
  SearchProviderCall,
  SearchProviderOutcome,
  SearchProviderPort,
} from '../../kernel/action/search-port.ts'

/** 缺省的两条合成结果（HTTPS、有摘要、无隐私） */
export const FIXTURE_DEFAULT_ITEMS: readonly SearchEvidenceItem[] = [
  {
    title: '示例文档 A —— 关于本季度的公开信息',
    url: 'https://example.com/docs/a',
    snippet: '这是一条合成摘要，用于离线验证证据链路（不是任何真实网页的内容）。',
  },
  {
    title: '示例文档 B —— 同一话题的另一个来源',
    url: 'https://example.org/notes/b',
    snippet: '第二条合成摘要：用来验证去重、标签顺序与来源附录。',
  },
]

export interface FixtureSearchProviderOptions {
  id?: string
  /** 固定条目（缺省 `FIXTURE_DEFAULT_ITEMS`）；与 `respond` 二选一，`respond` 优先 */
  items?: readonly SearchEvidenceItem[]
  /**
   * 按需应答（同步或异步）。负控脚本用它注入超时 / 失败 / 畸形结果。
   * 第 0 次调用 = 第一次搜索。
   */
  respond?: (
    call: SearchProviderCall,
    index: number
  ) => Promise<SearchProviderOutcome> | SearchProviderOutcome
  /** 模拟"慢 provider"：等待若干毫秒；等待期间被 abort ⇒ 返回 `cancelled` */
  delayMs?: number
  endpointHost?: string
}

export interface FixtureSearchProvider extends SearchProviderPort {
  /** 到目前为止**实际**被调用过几次（0 = 这一轮没有联网） */
  callCount(): number
  /** 每一次调用的入参（**只含 query/limit/locale**；用于断言没有夹带上下文） */
  calls(): readonly { query: string; limit: number; locale: string }[]
}

/** 便于负控构造"超时"这种结果（不是 httpx 超时，是**这一层**的结论） */
export function fixtureTimeoutOutcome(timeoutMs: number): SearchProviderOutcome {
  return {
    ok: false,
    failure: actionFailure('timeout', `fixture：模拟在 ${timeoutMs}ms 内没有返回`),
    requestCount: 1,
    rejectedItems: 0,
  }
}

export function fixtureFailureOutcome(message: string): SearchProviderOutcome {
  return {
    ok: false,
    failure: actionFailure('execution_failed', `fixture：${message}`),
    requestCount: 1,
    rejectedItems: 0,
  }
}

export function fixtureEmptyOutcome(): SearchProviderOutcome {
  return { ok: true, items: [], requestCount: 1, rejectedItems: 0 }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<'ok' | 'aborted'> {
  if (ms <= 0) return Promise.resolve(signal?.aborted === true ? 'aborted' : 'ok')
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(() => resolve('ok'), ms))
  }
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve('ok')
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createFixtureSearchProvider(
  options: FixtureSearchProviderOptions = {}
): FixtureSearchProvider {
  const id = options.id ?? 'fixture'
  const items = options.items ?? FIXTURE_DEFAULT_ITEMS
  const callLog: { query: string; limit: number; locale: string }[] = []

  return {
    id,
    endpointHost: options.endpointHost ?? 'fixture.invalid',

    async search(input): Promise<SearchProviderOutcome> {
      const index = callLog.length
      callLog.push({ query: input.query, limit: input.limit, locale: input.locale })

      if (options.delayMs !== undefined && options.delayMs > 0) {
        const waited = await wait(options.delayMs, input.signal)
        if (waited === 'aborted') {
          return {
            ok: false,
            failure: actionFailure('cancelled', 'fixture：等待期间被取消'),
            requestCount: 1,
            rejectedItems: 0,
          }
        }
      }

      if (options.respond !== undefined) return await options.respond(input, index)
      return { ok: true, items: [...items], requestCount: 1, rejectedItems: 0 }
    },

    callCount(): number {
      return callLog.length
    },

    calls(): readonly { query: string; limit: number; locale: string }[] {
      return [...callLog]
    },
  }
}
