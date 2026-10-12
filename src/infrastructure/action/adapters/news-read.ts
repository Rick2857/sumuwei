/**
 * `news.read` 适配器（第二批计划 §3.3）。
 *
 * ============================================================================
 *  两条刻意的复用，一条刻意的**不复用**
 * ============================================================================
 * 复用：
 * ```text
 * ① 网络那一侧：LG 的**受限 HTTPS 获取器**（`createPinnedHttpsFetcher`）——
 *    每一跳重新准入、地址分类、连接钉定、边读边掐上限。资讯**不新开**一条出站路径。
 * ② 深读：任务要读某一条全文时交给现有 `web.read`，本适配器只给链接。
 * ```
 * 不复用（计划书 §3.3 第 2 点逐字）：
 * ```text
 * 不用 `rss-parser.parseURL()` —— 它自己处理网络、重定向与 60 秒缺省超时，
 * 那是"绕过 LG 受限获取器"的入口。本适配器只调 `parseString()`。
 * ```
 *
 * ============================================================================
 *  解析前的三道闸
 * ============================================================================
 * ```text
 * ① Content-Type 必须是 XML/RSS/Atom 家族（不是就如实拒绝，不"试一下能不能解析"）
 * ② **拒绝 DTD / 实体声明**（`<!DOCTYPE` / `<!ENTITY`）：XXE 与实体展开炸弹的入口
 * ③ 字节上限（2 MiB）+ 条目上限（10 条候选 → 5 条交付）
 * ```
 *
 * ⚠️ **发布时间**：绝不"以抓取时间冒充发布时间"。服务没给就如实标 `未知`。
 */

import { createHash } from 'node:crypto'

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { NEWS_LIMITS, NEWS_READ, NEWS_READ_OPERATION } from '../../../kernel/action/news-capability.ts'
import { TURN_CONTENT_LIMITS } from '../../../kernel/contracts/turn-content.ts'
import type { LocalTextTurnContent, TurnContent } from '../../../kernel/contracts/turn-content.ts'
import { admitWebReadUrl } from './web-read.ts'
import { createPinnedHttpsFetcher, type WebReadFetcher } from './web-read.ts'
import { fnv1a64Hex } from '../../../kernel/action/idempotency.ts'

/** 允许的 Content-Type（XML / RSS / Atom 家族；其余一律拒绝） */
const ALLOWED_CONTENT_TYPES: readonly string[] = [
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
  'application/rdf+xml',
  'text/rss+xml',
  'application/json', // 少数源提供 JSON Feed；解析仍走 XML 路径 ⇒ 会在解析处如实失败
]

export interface NewsReadOptions {
  /** 测试缝：替换整段"获取"（替换的是 IO，不是准入与上限） */
  fetcher?: WebReadFetcher
  now?: () => number
  /** 测试缝：替换解析器（缺省真 `rss-parser`） */
  parse?: (xml: string) => Promise<ParsedFeed>
}

export interface ParsedFeedItem {
  title?: string
  link?: string
  isoDate?: string
  pubDate?: string
  contentSnippet?: string
  summary?: string
  creator?: string
}

export interface ParsedFeed {
  title?: string
  items: ParsedFeedItem[]
}

/**
 * 拒绝 DTD / 实体声明。
 *
 * ⚠️ 这是**解析之前**的字节闸：一旦交给 XML 解析器，实体展开就已经发生了。
 *    判据是字节里出现 `<!DOCTYPE` 或 `<!ENTITY`（大小写不敏感）—— 
 *    对 RSS/Atom 来说这两个声明**没有正当用途**。
 */
export function hasDtdOrEntityDeclaration(xml: string): boolean {
  return /<!DOCTYPE|<!ENTITY/i.test(xml)
}

/** Content-Type 是否属于 XML 家族（只看 mime，忽略参数） */
export function isXmlContentType(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const mime = raw.split(';')[0]!.trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.includes(mime)
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : at
}

function snippetOf(item: ParsedFeedItem): string {
  const raw = item.contentSnippet ?? item.summary ?? ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, 400)
}

export function createNewsReadAdapter(options: NewsReadOptions = {}): CapabilityAdapter {
  /*
   * ⚠️ 获取器必须显式声明 **XML 家族**（`contentTypeFamily: 'xml'`）。
   *
   * 缺省的 `createPinnedHttpsFetcher()` 只认 HTML —— 真实的 RSS/Atom 回的是
   * `application/xml` / `application/rss+xml`，会被那个闸**在读正文之前**拒掉
   * （真模型 live 实测：每一个真实订阅源都取不到）。
   * 这是"资讯复用受限获取器"唯一需要额外说清的一件事，别的都逐字相同：
   * 每一跳重新准入、地址分类、连接钉定、上限与超时全部照旧。
   */
  const fetcher = options.fetcher ?? createPinnedHttpsFetcher({ contentTypeFamily: 'xml' })
  const now = options.now ?? (() => Date.now())

  async function defaultParse(xml: string): Promise<ParsedFeed> {
    /*
     * ⚠️ 动态 import：`rss-parser` 只在真正要用它时才装载。
     *    资讯开关关着时，这个模块**根本不会被构造**（适配器在装配层按开关构造），
     *    因此它也不会进入进程的常驻依赖集。
     */
    const module = (await import('rss-parser')) as unknown as {
      default: new (options?: Record<string, unknown>) => {
        parseString(input: string): Promise<{ title?: string; items?: ParsedFeedItem[] }>
      }
    }
    const Parser = module.default
    const parser = new Parser()
    const parsed = await parser.parseString(xml)
    return { ...(parsed.title !== undefined ? { title: parsed.title } : {}), items: parsed.items ?? [] }
  }

  return {
    capabilityId: NEWS_READ,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const rawFeeds = input.args.feeds
      const feeds = Array.isArray(rawFeeds)
        ? rawFeeds.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : typeof rawFeeds === 'string' && rawFeeds.trim() !== ''
          ? [rawFeeds]
          : []
      if (feeds.length === 0) {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            '没有给出订阅源地址 —— 资讯读取需要明确的来源（没有来源时请用现有搜索能力）'
          )
        )
      }
      if (feeds.length > NEWS_LIMITS.maxFeeds) {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            `一次最多 ${String(NEWS_LIMITS.maxFeeds)} 个订阅源，收到 ${String(feeds.length)}`
          )
        )
      }

      const since = parseTime(input.args.since)
      const until = parseTime(input.args.until)
      const limitRaw = input.args.limit
      const limit =
        typeof limitRaw === 'number' && Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.trunc(limitRaw), 1), NEWS_LIMITS.maxDelivered)
          : NEWS_LIMITS.maxDelivered

      const fetchedAt = now()
      const deadlineAt = fetchedAt + 15_000
      const parse = options.parse ?? defaultParse

      const perFeed: { url: string; title?: string; count: number; error?: string }[] = []
      const collected: { item: ParsedFeedItem; feedUrl: string; feedTitle?: string; publishedAt?: number }[] = []

      for (const feedUrl of feeds) {
        // ① 准入（与 `web.read` 同一条：非 HTTPS / 私网 / 非法端口在这一步就拒）
        const admitted = admitWebReadUrl(feedUrl)
        if (!admitted.ok) {
          perFeed.push({ url: feedUrl, count: 0, error: `地址不被接受（${admitted.reason}）` })
          continue
        }
        // ② 受限获取
        let bytes: Buffer
        let contentType: string | undefined
        try {
          const result = await fetcher({ url: feedUrl, deadlineAt, maxBytes: NEWS_LIMITS.maxFeedBytes })
          bytes = result.bytes
          contentType = result.contentType
        } catch (error) {
          perFeed.push({
            url: feedUrl,
            count: 0,
            error: `获取失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          })
          continue
        }
        // ③ Content-Type 闸
        if (!isXmlContentType(contentType)) {
          perFeed.push({
            url: feedUrl,
            count: 0,
            error: `不是 XML/RSS/Atom 内容类型（${contentType ?? '(未声明)'}）`,
          })
          continue
        }
        const xml = bytes.toString('utf8')
        // ④ DTD / 实体声明闸（**解析之前**）
        if (hasDtdOrEntityDeclaration(xml)) {
          perFeed.push({
            url: feedUrl,
            count: 0,
            error: '响应体含 DTD 或实体声明 —— 首版拒绝解析（XXE / 实体展开的入口）',
          })
          continue
        }
        // ⑤ 解析
        let parsed: ParsedFeed
        try {
          parsed = await parse(xml)
        } catch (error) {
          perFeed.push({
            url: feedUrl,
            count: 0,
            error: `解析失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          })
          continue
        }
        perFeed.push({
          url: feedUrl,
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          count: parsed.items.length,
        })
        for (const item of parsed.items) {
          const published = parseTime(item.isoDate) ?? parseTime(item.pubDate)
          collected.push({
            item,
            feedUrl,
            ...(parsed.title !== undefined ? { feedTitle: parsed.title } : {}),
            ...(published !== undefined ? { publishedAt: published } : {}),
          })
        }
      }

      if (collected.length === 0) {
        const reasons = perFeed
          .map((feed) => `${feed.url}：${feed.error ?? '0 条条目'}`)
          .join(' · ')
        throw new ActionFailureError(
          actionFailure('execution_failed', `没有从任何订阅源取到条目（${reasons}）`.slice(0, 400))
        )
      }

      // ⑥ 时间过滤（未知发布时间的条目**保留**并如实标注，不按抓取时间补）
      const inRange = collected.filter((entry) => {
        if (entry.publishedAt === undefined) return true
        if (since !== undefined && entry.publishedAt < since) return false
        if (until !== undefined && entry.publishedAt > until) return false
        return true
      })

      // ⑦ 去重（同链接 / 同标题+同源）；排序按发布时间降序（未知放最后）
      const seen = new Set<string>()
      const deduped: typeof inRange = []
      for (const entry of inRange) {
        const key = (entry.item.link ?? `${entry.feedUrl}#${entry.item.title ?? ''}`).trim().toLowerCase()
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        deduped.push(entry)
      }
      deduped.sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1))
      const candidates = deduped.slice(0, NEWS_LIMITS.maxCandidates)
      const delivered = candidates.slice(0, limit)

      const lines: string[] = []
      delivered.forEach((entry, index) => {
        const published =
          entry.publishedAt !== undefined
            ? new Date(entry.publishedAt).toISOString()
            : '未知（订阅源没有给出发布时间）'
        lines.push(
          `[${String(index + 1)}] ${entry.item.title ?? '(无标题)'}`,
          `    来源：${entry.feedTitle ?? entry.feedUrl}`,
          `    发布时间：${published}`,
          `    链接：${entry.item.link ?? '(无链接)'}`,
          `    摘要：${snippetOf(entry.item) || '(无摘要)'}`,
          ''
        )
      })

      const header = [
        `订阅源：${feeds.length} 个（取到条目的 ${String(perFeed.filter((f) => f.error === undefined).length)} 个）`,
        `候选条目：${String(deduped.length)}（上限 ${String(NEWS_LIMITS.maxCandidates)}）· 本次交付 ${String(delivered.length)} 条（上限 ${String(limit)}）`,
        `时间范围：${since !== undefined ? new Date(since).toISOString() : '不限'} → ${until !== undefined ? new Date(until).toISOString() : '不限'}`,
        `抓取时间：${new Date(fetchedAt).toISOString()}`,
        '⚠️ 摘要来自订阅源自身；要读全文请把某一行的链接交给网页深读（web.read）',
        '⚠️ 转载不等于独立验证：同一链接只出现一次，但"多家转载同一条"不在本适配器的判别范围内',
        '',
      ].join('\n')
      const text = header + lines.join('\n')
      const shaped = text.slice(0, TURN_CONTENT_LIMITS.maxTextChars)

      const facts = [
        `订阅源：${perFeed
          .map((feed) => `${feed.title ?? feed.url}（${feed.error !== undefined ? `失败：${feed.error}` : `${String(feed.count)} 条`}）`)
          .join(' · ')}`,
        `交付条目：${String(delivered.length)} 条`,
        /*
         * ⚠️ 这两条进 **facts**（机器可核对的陈述），不只是正文里的一句话：
         *    "这一批是从哪个时间窗里取的"与"这是摘要还是全文"都是
         *    用户事后必须能复核的事实，而不是措辞。
         */
        `时间范围：${since !== undefined ? new Date(since).toISOString() : '不限'} → ${until !== undefined ? new Date(until).toISOString() : '不限'}`,
        '摘要与全文：这里的条目只带**订阅源自身给出的摘要**；要读全文请把该条链接交给 web.read（本适配器**不**自己去抓正文）',
        `未知发布时间的条目：${String(delivered.filter((e) => e.publishedAt === undefined).length)} 条（**不**用抓取时间补齐）`,
        `获取器：LG 受限 HTTPS 获取器（每跳重新准入，上限 ${String(NEWS_LIMITS.maxFeedBytes)} 字节）`,
        '解析器：rss-parser.parseString（**不**用 parseURL）',
        '已知局限：付费墙 / 动态正文不在订阅条目里 ⇒ 只有摘要时如实标注',
      ]

      const content: LocalTextTurnContent = {
        contentId: `${String(input.actionId)}:news`,
        kind: 'local-text',
        capability: NEWS_READ,
        operation: NEWS_READ_OPERATION,
        sourceKind: 'remote-service',
        resourceRef: feeds[0],
        sourceFingerprint: sha256(feeds.join('\n')),
        resultFingerprint: fnv1a64Hex(text),
        scope: {
          totalChars: text.length,
          includedChars: shaped.length,
          truncated: shaped.length < text.length,
        },
        facts,
        text: shaped,
        mediaType: 'application/x-news-digest',
        lineCount: shaped.split('\n').length,
        sourceBytes: Buffer.byteLength(text, 'utf8'),
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: 'content_read',
          detail: `资讯：${String(feeds.length)} 个源 / 交付 ${String(delivered.length)} 条`,
          fingerprint: content.resultFingerprint,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `news.read 源=${String(feeds.length)} 候选=${String(deduped.length)} ` +
              `交付=${String(delivered.length)} 抓取时间=${new Date(fetchedAt).toISOString()}`,
            ref: feeds[0],
          },
        ],
        turnContent,
      }
    },
  }
}

/** 便于诊断：一行说明（**不含 token、不含源正文**） */
export function describeNewsLimits(): string {
  return (
    `news.read ≤${String(NEWS_LIMITS.maxFeeds)} 源 · ≤${String(NEWS_LIMITS.maxCandidates)} 候选 · ` +
    `≤${String(NEWS_LIMITS.maxDelivered)} 交付 · ≤${String(NEWS_LIMITS.maxFeedBytes)} 字节/源`
  )
}

export { stringArg }
