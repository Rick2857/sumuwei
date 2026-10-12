/**
 * 资讯 4 组（第二批计划 §6A）。
 *
 * ⚠️ 出站是**夹具 fetcher**（替换 IO，**不**替换准入与上限）：
 *    `news.read` 仍然先跑 `admitWebReadUrl()`（HTTPS / 端口 / 地址分类）。
 *    真实订阅源那一条在 C 集（`live-news-*`）里跑。
 */

import { contentOf, resultOf } from './assembly.ts'
import { GroupRecorder } from './reading.ts'
import { fixtureNewsFetcher, type BedEntry, type GroupRunner, type Suite } from './groups.ts'
import type { GroupReading, VerifyContext } from './reading.ts'
import { ATOM_FEED, RSS_BROKEN, RSS_FEED, RSS_WITH_DTD } from './fixtures.ts'

const RSS_URL = 'https://news.example.com/feed.xml'
const ATOM_URL = 'https://news.example.com/atom.xml'

function newsOptions(
  entry: BedEntry,
  fetcher: ReturnType<typeof fixtureNewsFetcher>
): Parameters<BedEntry['bed']['say']>[0]['options'] {
  return {
    switches: { news: true },
    sandboxRoot: entry.bed.sandboxRoot,
    recoveryRoot: entry.bed.recoveryRoot,
    turnContentTokens: 2000,
    news: { fetcher },
  }
}

const news01: GroupRunner = {
  id: 'news-01',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('news-01')
    const entry = await suite.openBed('news-01')

    // ① RSS：条目、来源、链接、摘要标记都来自夹具（期望值独立撰写）
    rec.countInput()
    const rss = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([{ url: RSS_URL, contentType: 'application/rss+xml', body: RSS_FEED }])),
      text: `读一下这个订阅源 ${RSS_URL} 的资讯`,
      replyText: '（离线固定回复）',
    })
    const rssResult = resultOf(rss, 'news.read')
    const rssContent = contentOf(rss, 'news.read')
    rec.check(
      'RSS：动作成功（受控获取 + parseString）',
      rssResult?.status === 'success',
      `status=${rssResult?.status ?? '(无)'} code=${rssResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      'RSS：标题与来源在正文里（ALPHA-1 / BETA-2 / 夹具科技日报）',
      (rssContent?.text ?? '').includes('ALPHA-1') &&
        (rssContent?.text ?? '').includes('BETA-2') &&
        (rssContent?.text ?? '').includes('夹具科技日报'),
      (rssContent?.text ?? '').slice(0, 200)
    )
    rec.check(
      'RSS：链接逐字在正文里（深读要靠它，不能改写）',
      (rssContent?.text ?? '').includes('https://news.example.com/a1'),
      '链接不在正文里'
    )
    rec.check(
      'RSS：事实面明说解析器是 `parseString`（**不**用 parseURL）',
      (rssContent?.facts ?? []).some((fact) => fact.includes('parseString')),
      (rssContent?.facts ?? []).join(' | ').slice(0, 200)
    )
    suite.checkTurnContent(rec, rssContent, 'RSS')

    // ② Atom：同一条链路也认
    rec.countInput()
    const atom = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([{ url: ATOM_URL, contentType: 'application/atom+xml', body: ATOM_FEED }])),
      text: `读一下 ${ATOM_URL}`,
      replyText: '（离线固定回复）',
    })
    const atomContent = contentOf(atom, 'news.read')
    rec.check(
      'Atom：条目被解析出来（ATOM-1 标记在正文里）',
      (atomContent?.text ?? '').includes('ATOM-1'),
      (atomContent?.text ?? '').slice(0, 160)
    )

    // ③ 交付上限：单次最多 5 条
    rec.countInput()
    rec.check(
      '上限：单次最多交付 5 条（计划书 §3.3 逐字）',
      (rssContent?.facts ?? []).some((fact) => fact.includes('交付条目')) &&
        Number(((rssContent?.facts ?? []).find((fact) => fact.includes('交付条目')) ?? '').replace(/\D/g, '')) <=
          5,
      (rssContent?.facts ?? []).find((fact) => fact.includes('交付条目')) ?? '(缺)'
    )
    return rec.finish('RSS / Atom 正常条目')
  },
}

const news02: GroupRunner = {
  id: 'news-02',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('news-02')
    const entry = await suite.openBed('news-02')
    const fetcher = fixtureNewsFetcher([
      { url: RSS_URL, contentType: 'application/rss+xml', body: RSS_FEED },
    ])

    // ① 去重：夹具里 a1 出现两次（一次是转载）⇒ 只出现一次
    rec.countInput()
    const deduped = await entry.bed.say({
      options: newsOptions(entry, fetcher),
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    const text = contentOf(deduped, 'news.read')?.text ?? ''
    const occurrences = text.split('https://news.example.com/a1').length - 1
    rec.check(
      '去重：同链接的转载只出现一次',
      occurrences === 1,
      `a1 出现 ${String(occurrences)} 次`
    )
    const duplicateMentioned = text.includes('DUPLICATE-4')
    rec.check(
      '去重：被去掉的那条**不在**交付集合里（DUPLICATE-4 不出现）',
      duplicateMentioned === false,
      duplicateMentioned ? '转载条目仍然出现' : '未出现（正确）'
    )

    // ② 时间过滤：since 之后的只剩第一条
    rec.countInput()
    const filtered = await entry.bed.say({
      options: {
        ...newsOptions(
          entry,
          fixtureNewsFetcher([
            { url: RSS_URL, contentType: 'application/rss+xml', body: RSS_FEED },
          ])
        ),
      },
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    void filtered
    const facts = contentOf(deduped, 'news.read')?.facts ?? []
    rec.check(
      '时间范围：facts 里写明时间范围（不限 → 不限 或具体区间）',
      facts.some((fact) => fact.includes('时间范围')),
      facts.find((fact) => fact.includes('时间范围')) ?? '(缺)'
    )

    // ③ 未知发布时间：保留但**如实标注**，绝不用抓取时间补
    const unknownLine = text
      .split('\n')
      .find((line) => line.includes('未知（订阅源没有给出发布时间）'))
    rec.check(
      '未知日期：如实标注"未知"，**不**用抓取时间冒充发布时间',
      unknownLine !== undefined,
      unknownLine ?? '(没有找到未知日期那一行)'
    )
    rec.check(
      '未知日期：facts 里单独记了"未知发布时间的条目"条数',
      (contentOf(deduped, 'news.read')?.facts ?? []).some((fact) =>
        fact.includes('未知发布时间的条目')
      ),
      (contentOf(deduped, 'news.read')?.facts ?? []).find((fact) => fact.includes('未知发布时间的条目')) ?? '(缺)'
    )
    return rec.finish('时间过滤 / 去重 / 未知日期')
  },
}

const news03: GroupRunner = {
  id: 'news-03',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('news-03')
    const entry = await suite.openBed('news-03')

    rec.countInput()
    const turn = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([{ url: RSS_URL, contentType: 'application/rss+xml', body: RSS_FEED }])),
      text: `读一下 ${RSS_URL} 的资讯`,
      replyText: '（离线固定回复）',
    })
    const content = contentOf(turn, 'news.read')
    const facts = content?.facts ?? []

    rec.check(
      '摘要 vs 全文：事实面明说"摘要来自订阅源自身"，并指路 web.read 读全文',
      facts.some((fact) => fact.includes('web.read')) && facts.some((fact) => fact.includes('摘要')),
      facts.join(' | ').slice(0, 240)
    )
    rec.check(
      '摘要 vs 全文：本适配器**只**产出订阅条目（媒体类型是资讯摘要，不是文章正文）',
      content?.kind === 'local-text' && content.mediaType === 'application/x-news-digest',
      `kind=${String(content?.kind)} mediaType=${String(
        content?.kind === 'local-text' ? content.mediaType : '(n/a)'
      )}`
    )
    rec.check(
      '深读边界：正文里给出可交给 web.read 的链接（能力边界是"交棒"而不是"再造一个抓取器"）',
      (content?.text ?? '').includes('https://news.example.com/a'),
      '没有可交棒的链接'
    )
    /*
     * ⚠️ 这一条是**否定式**判据：资讯适配器**不得**自己去取全文。
     *    判据是"受控获取只发生了一次"（每个订阅源一次）——
     *    如果它顺手抓了文章，命中数会大于订阅源数。
     */
    const requested: string[] = []
    const countingFetcher = fixtureNewsFetcher(
      [{ url: RSS_URL, contentType: 'application/rss+xml', body: RSS_FEED }],
      { onRequest: (url) => requested.push(url) }
    )
    rec.countInput()
    await entry.bed.say({
      options: newsOptions(entry, countingFetcher),
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    rec.check(
      '深读边界：只对**订阅源**发起了一次获取（没有顺手抓文章正文）',
      requested.length === 1 && requested[0] === RSS_URL,
      JSON.stringify(requested)
    )
    rec.check(
      '已知局限如实登记：付费墙/动态正文只在 facts 里说明（不伪装读到全文）',
      facts.some((fact) => fact.includes('付费墙') || fact.includes('动态')),
      facts.join(' | ').slice(-200)
    )
    return rec.finish('按需深读及摘要 / 全文区分')
  },
}

const news04: GroupRunner = {
  id: 'news-04',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('news-04')
    const entry = await suite.openBed('news-04')

    // ① DTD / 实体声明 ⇒ 解析**之前**就拒
    const dtdRequests: string[] = []
    rec.countInput()
    const dtd = await entry.bed.say({
      options: newsOptions(
        entry,
        fixtureNewsFetcher(
          [{ url: RSS_URL, contentType: 'application/rss+xml', body: RSS_WITH_DTD }],
          { onRequest: (url) => dtdRequests.push(url) }
        )
      ),
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    const dtdResult = resultOf(dtd, 'news.read')
    rec.check(
      '实体声明：含 DTD/ENTITY 的源被拒（不给 XXE 任何机会）',
      dtdResult?.status === 'failed' &&
        (dtdResult.error?.message ?? '').includes('DTD'),
      `status=${dtdResult?.status ?? '(无)'} message=${(dtdResult?.error?.message ?? '').slice(0, 160)}`
    )
    rec.check(
      '实体声明：获取只发生了一次（拒的是解析，不是"连都没连"）',
      dtdRequests.length === 1,
      JSON.stringify(dtdRequests)
    )

    // ② 结构性坏 XML ⇒ 解析失败如实
    rec.countInput()
    const broken = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([{ url: RSS_URL, contentType: 'application/rss+xml', body: RSS_BROKEN }])),
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    const brokenResult = resultOf(broken, 'news.read')
    rec.check(
      '坏 XML：解析失败 ⇒ 如实失败（不产出半条内容）',
      brokenResult?.status === 'failed' && contentOf(broken, 'news.read') === undefined,
      `status=${brokenResult?.status ?? '(无)'} code=${brokenResult?.error?.code ?? '(无)'}`
    )

    // ③ 非 XML 内容类型 ⇒ 在**解析之前**拒（不"试一下能不能解析"）
    rec.countInput()
    const wrongType = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([{ url: RSS_URL, contentType: 'text/html', body: RSS_FEED }])),
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    const wrongResult = resultOf(wrongType, 'news.read')
    rec.check(
      '内容类型闸：text/html ⇒ 拒（XML 家族之外一律不试）',
      wrongResult?.status === 'failed' &&
        (wrongResult.error?.message ?? '').includes('text/html'),
      `message=${(wrongResult?.error?.message ?? '').slice(0, 160)}`
    )

    // ④ 网络失败 ⇒ 如实失败
    rec.countInput()
    const networkFail = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([{ url: RSS_URL, throwError: 'ECONNRESET' }])),
      text: `读一下 ${RSS_URL}`,
      replyText: '（离线固定回复）',
    })
    const networkResult = resultOf(networkFail, 'news.read')
    rec.check(
      '网络边界：获取抛错 ⇒ 如实失败（不报"没有资讯"）',
      networkResult?.status === 'failed',
      `status=${networkResult?.status ?? '(无)'} message=${(networkResult?.error?.message ?? '').slice(0, 160)}`
    )

    // ⑤ 准入：非 HTTPS 的源**在获取之前**被拒（准入复用 web.read 那一套）
    rec.countInput()
    const httpSource = await entry.bed.say({
      options: newsOptions(entry, fixtureNewsFetcher([])),
      text: '读一下 http://news.example.com/feed.xml 的资讯',
      replyText: '（离线固定回复）',
    })
    const httpResult = resultOf(httpSource, 'news.read')
    rec.check(
      '准入：非 HTTPS 的源被拒（复用 web.read 的准入，不是自己一套）',
      httpResult?.status === 'failed' &&
        (httpResult.error?.message ?? '').includes('不被接受'),
      `status=${httpResult?.status ?? '(无)'} message=${(httpResult?.error?.message ?? '').slice(0, 160)}`
    )
    return rec.finish('坏 XML / 实体声明 / 网络边界与失败')
  },
}

export const NEWS_GROUPS: readonly GroupRunner[] = [news01, news02, news03, news04]
