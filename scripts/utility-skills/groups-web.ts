/**
 * groups-web —— 网页深读的 6 组（计划书 §4A「网页 6 组」）。
 *
 * ```text
 * web-01 中文静态正文 / 去导航      真实 DOM 正文提取与 fixture 一致
 * web-02 允许重定向                最终 URL、抓取时间与指纹可查；逐跳复验
 * web-03 禁止地址 / 协议 / 端口     受禁目标连接数 0
 * web-04 DNS / 重定向连接约束       校验过的地址与实际连接地址一致
 * web-05 状态码、超时 / 超限        状态与实测一致；超限在读取阶段终止
 * web-06 脚本、子资源、动态空壳       DOM 不执行脚本、不加载子资源
 * ```
 *
 * ⚠️ **夹具只替换 IO，不替换判定**。适配器本体在进入获取阶段**之前**会自己调一次
 *    `admitWebReadUrl`（那一处**不可注入**），因此夹具的主机名必须**真的解析成公网地址**
 *    才能过第一道门。夹具替换的正是适配器留缝的那两层：
 *    `resolve`（Hosts 表）与 `connect`（把已校验的地址换成夹具端口，TLS 逐字保留）。
 *    准入 / 逐地址分类 / 固定地址决定 / 有界读 / content-type 门 / 提取**全部**是真实现。
 *
 * ⚠️ 这一条是本组第一版的**真实缺陷**（读数保留在 `local/` 的探针日志里）：
 *    当时夹具把主机名解析成 `127.0.0.1`，于是适配器在获取阶段之前就正确地报
 *    `forbidden_address`，六组全红 —— 那是**夹具配错了**，不是适配器的问题。
 */

import { WEB_READ } from '../../src/kernel/action/utility-capabilities.ts'
import {
  admitWebReadUrl,
  classifyAddress,
} from '../../src/infrastructure/action/adapters/web-read.ts'
import type { TurnContent } from '../../src/kernel/contracts/turn-content.ts'

import { resultOf, summarizeActions } from './assembly.ts'
import type { GroupRunner, Suite } from './groups.ts'
import { GroupRecorder, sanitize } from './groups.ts'
import { webExpectOf } from './fixtures.ts'
import { FIXTURE_PUBLIC_IP, makeFixtureFetcher, makeResolvingFetcher } from './transport.ts'

async function webGroupsUnavailable(
  suite: Suite,
  id: string,
  title: string
): Promise<ReturnType<GroupRecorder['finish']> | undefined> {
  const rec = new GroupRecorder(id)
  if (!suite.fixturesUsable) return rec.finish(title, { notRunReason: suite.fixturesProblem })
  try {
    await suite.web()
    return undefined
  } catch (error) {
    return rec.finish(title, {
      notRunReason: `${suite.webProblem}：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

const web01: GroupRunner = {
  id: 'web-01',
  async run(_ctx, suite) {
    const unavailable = await webGroupsUnavailable(suite, 'web-01', '中文静态正文 / 去导航')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('web-01')
    const entry = await suite.openBed('web01')
    const bundle = await suite.web()
    const expected = webExpectOf(suite.fixtures, 'web-article.html')
    const before = bundle.fetcher.reading.connectCalls

    const got = await suite.readWeb(entry, bundle.articleUrl, {
      resolve: bundle.fetcher.resolve,
      connect: bundle.fetcher.connect,
    })
    rec.countInput(1)
    const content = got.content
    suite.checkTurnContent(rec, content, 'web-01 当轮内容')

    const text = content?.text ?? ''
    const missing = (expected.articleMustContain ?? []).filter((needle) => !text.includes(needle))
    rec.check(
      'web-01 正文提取：manifest 声明的**全部**关键片段都出现（含那条注入样本原文与数字 7.25）',
      missing.length === 0 && (expected.articleMustContain?.length ?? 0) > 0,
      missing.length === 0 ? `全部命中（${String(expected.articleMustContain?.length ?? 0)} 条）` : `缺少：${missing.join(' / ')}`
    )
    const leaked = (expected.articleMustNotContain ?? []).filter((needle) => text.includes(needle))
    rec.check(
      'web-01 去导航 / 去广告：`SCRIPT-RAN` 与广告文案**都没有**泄漏进正文',
      leaked.length === 0,
      leaked.length === 0 ? '没有泄漏' : `泄漏：${leaked.join(' / ')}`
    )
    rec.check(
      'web-01 标题：`title` 与 manifest 逐字一致',
      content?.kind !== 'web-article' ? false : content.title === expected.title,
      `title=${content?.kind === 'web-article' ? String(content.title) : '(无)'}`
    )
    rec.check(
      'web-01 正文体量：字符数 ≥ manifest 的 `minBodyChars`，段落数 ≥ `minArticleParagraphs`',
      (content?.scope.includedChars ?? 0) >= (expected.minBodyChars ?? 0) &&
        text.split('\n').filter((line) => line.trim() !== '').length >= (expected.minArticleParagraphs ?? 0),
      `chars=${String(content?.scope.includedChars)} lines=${String(text.split('\n').length)}`
    )
    rec.check(
      'web-01 来源与范围：`resourceRef` = 最终 URL，`fetchedAt` 是程序给的时间，指纹是程序算的',
      content?.kind === 'web-article' &&
        content.finalUrl === bundle.articleUrl &&
        typeof content.fetchedAt === 'number' &&
        (content.sourceFingerprint ?? '').length === 64,
      `finalUrl=${content?.kind === 'web-article' ? content.finalUrl : '(无)'}`
    )
    rec.check(
      'web-01 真的出了网（对本地夹具）：这一轮至少发生了一次连接（否则上面的正文从哪来）',
      bundle.fetcher.reading.connectCalls > before,
      `connectCalls=${String(bundle.fetcher.reading.connectCalls)}`
    )
    /* 排版无关性：同一篇文章压成一行，提取结果里的关键片段必须仍在 */
    const minified = await suite.readWeb(entry, bundle.minifiedUrl, {
      resolve: bundle.fetcher.resolve,
      connect: bundle.fetcher.connect,
    })
    rec.countInput(1)
    rec.check(
      'web-01 排版无关：同一篇文章压成一行后，关键片段仍被提取（提取不靠换行猜结构）',
      (minified.content?.text ?? '').includes('莫比乌斯环的测量基准是 2026 年 10 月') &&
        (minified.content?.text ?? '').includes('7.25'),
      `chars=${String(minified.content?.scope.includedChars)}`
    )
    rec.note('article', {
      chars: content?.scope.includedChars ?? 0,
      title: content?.kind === 'web-article' ? content.title : null,
      connectCalls: bundle.fetcher.reading.connectCalls,
    })
    return rec.finish('中文静态正文 / 去导航')
  },
}

const web02: GroupRunner = {
  id: 'web-02',
  async run(_ctx, suite) {
    const unavailable = await webGroupsUnavailable(suite, 'web-02', '允许重定向')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('web-02')
    const entry = await suite.openBed('web02')
    const bundle = await suite.web()
    const hooks = { resolve: bundle.fetcher.resolve, connect: bundle.fetcher.connect }
    const redirectBaseline = bundle.fetcher.reading.connectTargets.length

    const got = await suite.readWeb(entry, bundle.redirectUrl, hooks)
    rec.countInput(1)
    const content = got.content
    /* ⚠️ 只看**这一档**的连接：夹具的 reading 是整组累计的 */
    const redirectTargets = bundle.fetcher.reading.connectTargets.slice(redirectBaseline)
    suite.checkTurnContent(rec, content, 'web-02 当轮内容')

    rec.check(
      'web-02 允许重定向：终态成功，正文来自**重定向之后**那一跳（`7.25` 在其中）',
      content?.kind === 'web-article' && content.text.includes('7.25'),
      `kind=${String(content?.kind)}`
    )
    rec.check(
      'web-02 最终 URL 可查：`finalUrl` = 重定向目标（不是最初那个地址）',
      content?.kind === 'web-article' && content.finalUrl === bundle.articleUrl,
      `finalUrl=${content?.kind === 'web-article' ? content.finalUrl : '(无)'}`
    )
    rec.check(
      'web-02 逐跳复验：facts 里如实记下跳数与重定向次数（1 次重定向 / 2 跳）',
      (content?.facts ?? []).some((fact) => fact.includes('重定向 1 次')) &&
        (content?.facts ?? []).some((fact) => fact.includes('2 跳')),
      (content?.facts ?? []).join(' · ')
    )
    rec.check(
      'web-02 抓取时间与指纹可查：`fetchedAt` 是数字，源指纹是响应体字节的 sha256',
      content?.kind === 'web-article' &&
        typeof content.fetchedAt === 'number' &&
        (content.sourceFingerprint ?? '').length === 64,
      `sourceFingerprint=${String(content?.sourceFingerprint).slice(0, 16)}…`
    )
    rec.check(
      'web-02 两跳都**真的**连了（本地夹具的连接计数 ≥ 2）',
      bundle.fetcher.reading.connectCalls >= 2,
      `connectCalls=${String(bundle.fetcher.reading.connectCalls)}`
    )
    rec.check(
      `web-02 每一跳都连到**校验过的那个地址**（夹具解析结果 ${FIXTURE_PUBLIC_IP}）`,
      redirectTargets.length >= 2 &&
        redirectTargets.every((target) => target.address === FIXTURE_PUBLIC_IP),
      JSON.stringify(redirectTargets)
    )

    /* 重定向次数上限：3 次之后必须停（循环重定向 ⇒ 明确拒绝） */
    const loop = await suite.readWeb(entry, bundle.loopUrl, hooks)
    rec.countInput(1)
    const loopResult = resultOf(loop.reading, WEB_READ)
    rec.check(
      'web-02 重定向上限：循环重定向在 3 次之后被拒（`too_many_redirects`），不是无限跟',
      loopResult?.status === 'rejected' &&
        loopResult?.error?.code === 'validation_failed' &&
        (loopResult.error.details?.reason === 'too_many_redirects' ||
          (loopResult.error.message ?? '').includes('too_many_redirects')),
      `code=${String(loopResult?.error?.code)} details=${JSON.stringify(loopResult?.error?.details ?? {})}`
    )
    rec.check(
      'web-02 重定向上限：超限时没有当轮内容，回复守卫顶替成功口吻',
      loop.reading.turnContent.length === 0 && !loop.reading.replyText.includes('我读到了'),
      `reply=${sanitize(loop.reading.replyText)}`
    )
    rec.check(
      'web-02 重定向上限：跳数如实可查（`hopCount` / `hops` 在失败详情里）',
      typeof loopResult?.error?.details?.hopIndex === 'number' ||
        Array.isArray(loopResult?.error?.details?.hops),
      JSON.stringify(loopResult?.error?.details ?? {}).slice(0, 200)
    )
    rec.note('redirect', {
      finalUrl: content?.kind === 'web-article' ? content.finalUrl : null,
      hops: content?.facts?.filter((fact) => fact.includes('跳')) ?? [],
      loopReason: String(loopResult?.error?.details?.reason ?? ''),
    })
    return rec.finish('允许重定向')
  },
}

const web03: GroupRunner = {
  id: 'web-03',
  async run(_ctx, suite) {
    const unavailable = await webGroupsUnavailable(suite, 'web-03', '禁止地址 / 协议 / 端口')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('web-03')
    const entry = await suite.openBed('web03')
    const bundle = await suite.web()
    const hooks = { resolve: bundle.fetcher.resolve, connect: bundle.fetcher.connect }

    /*
     * ==========================================================================
     *  ① 准入层（**纯函数**，真实实现）：逐类具名拒绝
     * ==========================================================================
     * ⚠️ 这一层必须单独测，理由是**实测到的一条结构事实**：
     *    检测器只认句中的 `https://` URL（`HTTPS_URL_TOKEN`）⇒ `http://…` / `file://…`
     *    这类形状**根本产生不了请求**，走不到适配器的准入检查。
     *    把"检测器不认"说成"适配器拒绝了"是一种粉饰，因此两档分列：
     *      · 准入层：`admitWebReadUrl()` 对每一类受禁形状给出**具名理由**
     *      · 网关层：**连接数 0**（下面 ② 的循环，只跑检测器真的会产生的那一档）
     */
    const admissionCases: readonly { url: string; reason: string; why: string }[] = [
      { url: 'http://article.test/', reason: 'not_https', why: '协议不是 https' },
      { url: 'file:///C:/Windows/win.ini', reason: 'not_https', why: 'file: 协议' },
      { url: 'ftp://article.test/x', reason: 'not_https', why: 'ftp: 协议' },
      { url: 'https://article.test:8443/', reason: 'bad_port', why: '端口不是 443' },
      { url: 'https://article.test:80/', reason: 'bad_port', why: '端口 80' },
      { url: 'https://user:pass@article.test/', reason: 'userinfo', why: 'URL 里带用户凭据' },
      { url: 'https://127.0.0.1/', reason: 'forbidden_address', why: '字面量回环地址' },
      { url: 'https://10.0.0.5/', reason: 'forbidden_address', why: '字面量私网地址' },
      { url: 'https://169.254.169.254/', reason: 'forbidden_address', why: '链路本地（云元数据端点）' },
      { url: 'https://[::1]/', reason: 'forbidden_address', why: 'IPv6 回环' },
      { url: 'https://[fe80::1]/', reason: 'forbidden_address', why: 'IPv6 链路本地' },
      { url: 'https://[::ffff:127.0.0.1]/', reason: 'forbidden_address', why: 'IPv4-mapped IPv6 回环' },
      { url: 'https://93.184.216.34/', reason: '', why: '字面量**公网**地址（正控：必须放行）' },
      { url: 'not a url', reason: 'bad_url', why: '根本不是 URL' },
      { url: '/etc/passwd', reason: 'bad_url', why: '裸路径' },
    ]
    for (const item of admissionCases) {
      const admitted = admitWebReadUrl(item.url)
      rec.countInput(1)
      rec.check(
        `web-03 准入层（**真实纯函数**）：\`${item.url}\`（${item.why}）${
          item.reason === '' ? '**通过**' : `被具名拒绝：\`${item.reason}\``
        }`,
        item.reason === '' ? admitted.ok === true : admitted.ok === false && admitted.reason === item.reason,
        admitted.ok ? `ok host=${admitted.host}` : `reason=${admitted.reason}`
      )
    }

    /*
     * ==========================================================================
     *  ② 网关层：**受禁目标连接数 0**
     * ==========================================================================
     * 只跑"检测器真的会产生请求"的那一档（显式 `https://` URL）。
     */
    const gatewayCases: readonly { url: string; reason: string; why: string }[] = [
      { url: 'https://127.0.0.1/', reason: 'forbidden_address', why: '字面量回环地址' },
      { url: 'https://10.0.0.5/', reason: 'forbidden_address', why: '字面量私网地址' },
      { url: 'https://169.254.169.254/', reason: 'forbidden_address', why: '链路本地（云元数据端点）' },
      { url: 'https://[::1]/', reason: 'forbidden_address', why: 'IPv6 回环' },
      { url: 'https://[fe80::1]/', reason: 'forbidden_address', why: 'IPv6 链路本地' },
      { url: 'https://[::ffff:127.0.0.1]/', reason: 'forbidden_address', why: 'IPv4-mapped IPv6 回环' },
    ]
    for (const target of gatewayCases) {
      const beforeConnects = bundle.fetcher.reading.connectCalls
      const got = await suite.readWeb(entry, target.url, hooks, { text: `帮我读一下 ${target.url}` })
      rec.countInput(1)
      const result = resultOf(got.reading, WEB_READ)
      const connects = bundle.fetcher.reading.connectCalls - beforeConnects
      rec.check(
        `web-03 网关层受禁目标（${target.why}）：**连接数 0**（一个字节都没出去）`,
        connects === 0,
        `connects=${String(connects)}`
      )
      rec.check(
        `web-03 网关层受禁目标（${target.why}）：姿态是 \`validation_failed\` 拒绝（不是 execution_failed，也不是"没听懂"）`,
        result?.status === 'rejected' &&
          result?.error?.code === 'validation_failed' &&
          result?.error?.details?.reason === target.reason,
        `code=${String(result?.error?.code)} status=${String(result?.status)} reason=${String(result?.error?.details?.reason)}`
      )
      rec.check(
        `web-03 网关层受禁目标（${target.why}）：没有当轮内容 ⇒ 不可能有"我已阅读"的事实`,
        got.reading.turnContent.length === 0,
        `turnContent=${String(got.reading.turnContent.length)}`
      )
      rec.note(`blocked:${target.why}`, { connects, reason: String(result?.error?.details?.reason ?? '') })
    }

    /* 分类器正控：真实实现（纯函数）对已知地址必须给出预期类别 */
    const classified: readonly { address: string; scope: string }[] = [
      { address: '127.0.0.1', scope: 'loopback' },
      { address: '10.1.2.3', scope: 'private' },
      { address: '169.254.169.254', scope: 'link_local' },
      { address: '::1', scope: 'loopback' },
      { address: 'fe80::1', scope: 'link_local' },
      { address: '::ffff:127.0.0.1', scope: 'loopback' },
      { address: FIXTURE_PUBLIC_IP, scope: 'public' },
      { address: '8.8.8.8', scope: 'public' },
      { address: '2001:4860:4860::8888', scope: 'public' },
    ]
    for (const item of classified) {
      const got = classifyAddress(item.address)
      rec.countInput(1)
      rec.check(
        `web-03 地址分类（**真实实现**的纯函数）：\`${item.address}\` 判为 ${item.scope}`,
        got.scope === item.scope,
        `scope=${got.scope} allowed=${String(got.allowed)}`
      )
    }
    rec.check(
      'web-03 计数型自检：准入层与网关层**逐档**都真的跑过输入（每条都记了自己的读数）',
      admissionCases.length >= 14 && gatewayCases.length >= 6 && rec.measured >= 20,
      `admission=${String(admissionCases.length)} gateway=${String(gatewayCases.length)} measured=${String(rec.measured)}`
    )
    rec.note('classifier', classified)
    return rec.finish('禁止地址 / 协议 / 端口')
  },
}

const web04: GroupRunner = {
  id: 'web-04',
  async run(_ctx, suite) {
    const unavailable = await webGroupsUnavailable(suite, 'web-04', 'DNS / 重定向连接约束')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('web-04')
    const entry = await suite.openBed('web04')
    const bundle = await suite.web()
    const hooks = { resolve: bundle.fetcher.resolve, connect: bundle.fetcher.connect }

    /* ① 正常路径：校验过的地址 = 实际连接的地址 */
    const before = bundle.fetcher.reading.connectTargets.length
    await suite.readWeb(entry, bundle.articleUrl, hooks)
    rec.countInput(1)
    const targets = bundle.fetcher.reading.connectTargets.slice(before)
    rec.check(
      `web-04 地址固定：实际连接的是**解析并校验过**的那个地址（${FIXTURE_PUBLIC_IP}），而不是重新解析主机名`,
      targets.length > 0 && targets.every((target) => target.address === FIXTURE_PUBLIC_IP),
      JSON.stringify(targets)
    )
    rec.check(
      'web-04 TLS 主机名不丢：连接同时给出 `servername` = 原主机名（证书/SNI 校验仍生效）',
      targets.every((target) => target.servername === 'article.test'),
      JSON.stringify(targets.map((target) => target.servername))
    )

    /*
     * ② 字面量公网地址：**跳过 DNS**（`resolveCalls` 不增），但仍要过准入与连接。
     *    这条用的是真实 `admitWebReadUrl`（字面量公网 ⇒ 放行）与真实分类器。
     */
    const literalFetcher = makeFixtureFetcher({ fixture: bundle.fixture, throwOnResolve: true })
    const literal = await suite.readWeb(entry, `https://${FIXTURE_PUBLIC_IP}/`, {
      ...hooks,
      resolve: literalFetcher.resolve,
    })
    rec.countInput(1)
    rec.check(
      'web-04 字面量公网地址：跳过 DNS（解析器 0 次调用）但仍要过准入与连接',
      literalFetcher.reading.resolveCalls === 0,
      `resolveCalls=${String(literalFetcher.reading.resolveCalls)} status=${String(resultOf(literal.reading, WEB_READ)?.status)}`
    )
    rec.check(
      'web-04 字面量公网地址：连接失败/无内容时如实降档（不是"读到了"）',
      resultOf(literal.reading, WEB_READ)?.status !== 'success' &&
        literal.reading.turnContent.length === 0,
      JSON.stringify(summarizeActions(literal.reading))
    )

    /* ③ 混合解析：一个主机名同时解析出公网与回环 ⇒ **整跳拒绝**（不挑公网那个） */
    const resolveWith = async (host: string): Promise<readonly string[]> =>
      bundle.extraHosts.get(host.toLowerCase()) ?? bundle.fetcher.resolve(host)
    const bogus = await suite.readWeb(entry, 'https://mixed.test/', {
      fetchHtml: makeResolvingFetcher(bundle.fixture, resolveWith),
    })
    rec.countInput(1)
    const bogusResult = resultOf(bogus.reading, WEB_READ)
    rec.check(
      'web-04 逐地址校验：解析出「公网 + 回环」时**整跳拒绝**（绝不挑一个连上去）',
      bogusResult?.status === 'rejected' &&
        (bogusResult.error?.details?.reason === 'forbidden_address' ||
          (bogusResult.error?.message ?? '').includes('forbidden_address')),
      `code=${String(bogusResult?.error?.code)} reason=${String(bogusResult?.error?.details?.reason)}`
    )
    rec.check(
      'web-04 逐地址校验：失败详情里列出了**解析出来的全部地址**（可事后核对）',
      Array.isArray(bogusResult?.error?.details?.resolvedAddresses) &&
        (bogusResult?.error?.details?.resolvedAddresses as unknown[]).length === 2,
      JSON.stringify(bogusResult?.error?.details?.resolvedAddresses ?? null)
    )
    rec.check(
      'web-04 逐地址校验：整跳拒绝时**没有当轮内容**',
      bogus.reading.turnContent.length === 0,
      `turnContent=${String(bogus.reading.turnContent.length)}`
    )

    /* ④ 私网解析 */
    const privateOnly = await suite.readWeb(entry, 'https://private.test/', {
      fetchHtml: makeResolvingFetcher(bundle.fixture, resolveWith),
    })
    rec.countInput(1)
    const privateResult = resultOf(privateOnly.reading, WEB_READ)
    rec.check(
      'web-04 私网解析：解析结果是私网地址 ⇒ 拒绝，且没有当轮内容',
      privateResult?.status === 'rejected' &&
        privateResult.error?.details?.reason === 'forbidden_address' &&
        privateOnly.reading.turnContent.length === 0,
      `reason=${String(privateResult?.error?.details?.reason)}`
    )

    /* ⑤ DNS 无应答 ⇒ `dns_no_answer`（不是"没找到文章"） */
    const empty = await suite.readWeb(entry, 'https://empty.test/', {
      fetchHtml: makeResolvingFetcher(bundle.fixture, resolveWith),
    })
    rec.countInput(1)
    const emptyResult = resultOf(empty.reading, WEB_READ)
    rec.check(
      'web-04 DNS 无应答：解析返回空数组 ⇒ `dns_no_answer` 如实降档（不是"没找到文章"）',
      emptyResult?.error?.details?.reason === 'dns_no_answer' ||
        (emptyResult?.error?.message ?? '').includes('dns_no_answer'),
      `reason=${String(emptyResult?.error?.details?.reason)}`
    )

    /* ⑥ 解析失败（抛错）⇒ 不是"文章不存在" */
    const failing = await suite.readWeb(entry, 'https://article.test/', {
      fetchHtml: makeResolvingFetcher(bundle.fixture, async () => {
        throw new Error('夹具：解析失败')
      }),
    })
    rec.countInput(1)
    const failingResult = resultOf(failing.reading, WEB_READ)
    rec.check(
      'web-04 解析失败：连接/解析异常如实降档（`execution_failed`），不谎称"没找到文章"',
      failingResult?.status === 'failed' && failing.reading.turnContent.length === 0,
      `status=${String(failingResult?.status)} code=${String(failingResult?.error?.code)}`
    )
    rec.note('dns', {
      targets,
      mixedResolved: bogusResult?.error?.details?.resolvedAddresses ?? null,
    })
    return rec.finish('DNS / 重定向连接约束')
  },
}

const web05: GroupRunner = {
  id: 'web-05',
  async run(_ctx, suite) {
    const unavailable = await webGroupsUnavailable(suite, 'web-05', '状态码、超时 / 超限')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('web-05')
    const entry = await suite.openBed('web05')
    const bundle = await suite.web()
    const hooks = { resolve: bundle.fetcher.resolve, connect: bundle.fetcher.connect }

    /* 404 / 410 ⇒ target_not_found；其它非 2xx ⇒ execution_failed（状态码原样保留） */
    const notFound = await suite.readWeb(entry, bundle.notFoundUrl, hooks)
    rec.countInput(1)
    const notFoundResult = resultOf(notFound.reading, WEB_READ)
    rec.check(
      'web-05 404：如实降档为 `target_not_found`，且状态码原样保留在详情里',
      notFoundResult?.status === 'not_found' &&
        notFoundResult.error?.code === 'target_not_found' &&
        notFoundResult.error.details?.httpStatus === 404,
      `status=${String(notFoundResult?.status)} httpStatus=${String(notFoundResult?.error?.details?.httpStatus)}`
    )

    const serverError = await suite.readWeb(entry, bundle.serverErrorUrl, hooks)
    rec.countInput(1)
    const serverErrorResult = resultOf(serverError.reading, WEB_READ)
    rec.check(
      'web-05 500：如实降档为 `execution_failed`（与 404 可分辨），状态码 500 原样保留',
      serverErrorResult?.status === 'failed' &&
        serverErrorResult.error?.code === 'execution_failed' &&
        serverErrorResult.error.details?.httpStatus === 500,
      `status=${String(serverErrorResult?.status)} httpStatus=${String(serverErrorResult?.error?.details?.httpStatus)}`
    )
    rec.check(
      'web-05 状态与实测一致：两次失败都**没有**当轮内容（不把错误页当正文）',
      notFound.reading.turnContent.length === 0 && serverError.reading.turnContent.length === 0,
      `404=${String(notFound.reading.turnContent.length)} 500=${String(serverError.reading.turnContent.length)}`
    )

    /* content-type 不是 HTML ⇒ 在读正文之前就拒绝 */
    const json = await suite.readWeb(entry, bundle.jsonUrl, hooks)
    rec.countInput(1)
    const jsonResult = resultOf(json.reading, WEB_READ)
    rec.check(
      'web-05 content-type 门：`application/json` 在**读正文之前**被拒（`unsupported_content_type`）',
      jsonResult?.status === 'rejected' &&
        jsonResult.error?.code === 'validation_failed' &&
        jsonResult.error.details?.reason === 'unsupported_content_type',
      `code=${String(jsonResult?.error?.code)} reason=${String(jsonResult?.error?.details?.reason)}`
    )

    /* 超时：服务端 4 秒不响应，客户端总期限 500ms ⇒ 必须按 `timeout` 收尾 */
    const slow = await suite.readWeb(entry, bundle.slowUrl, hooks, { totalTimeoutMs: 500 })
    rec.countInput(1)
    const slowResult = resultOf(slow.reading, WEB_READ)
    rec.check(
      'web-05 超时：总期限 500ms 对上一个 4 秒不响应的服务端 ⇒ 终态是 `timeout`（不是 failed）',
      slowResult?.status === 'timeout' && slowResult.error?.code === 'timeout',
      `status=${String(slowResult?.status)} code=${String(slowResult?.error?.code)}`
    )
    rec.check(
      'web-05 超时：没有当轮内容，回复守卫顶替成如实句',
      slow.reading.turnContent.length === 0 &&
        slow.reading.guard.turnContent.states.some((state) => state.state === 'timeout'),
      sanitize(slow.reading.replyText)
    )

    /* 超限：服务端准备 4 MiB（64 × 64 KiB），客户端上限 2 MiB ⇒ 在读取阶段终止 */
    const largeBefore = bundle.fixture.served.filter(
      (row) => row.host.startsWith('large.test') && row.path === '/'
    ).length
    const large = await suite.readWeb(entry, bundle.largeUrl, { ...hooks, maxBytes: 2 * 1024 * 1024 })
    rec.countInput(1)
    const largeResult = resultOf(large.reading, WEB_READ)
    rec.check(
      'web-05 超限：4 MiB 响应体在 2 MiB 上限处被中断（`body_too_large`）',
      largeResult?.status === 'rejected' &&
        largeResult.error?.code === 'validation_failed' &&
        largeResult.error.details?.reason === 'body_too_large',
      `code=${String(largeResult?.error?.code)} reason=${String(largeResult?.error?.details?.reason)}`
    )
    /*
     * 判据分两半，**各自都能自证**：
     *   ① 客户端侧（**权威读数**）：适配器在读满 2 MiB 上限时立刻中断，并从错误详情里报出
     *      **实际收到的字节数** —— 这就是"不是先缓冲完再看大小"的直接证据
     *   ② 服务端侧（**诊断**）：夹具的 chunked 计数器在本路径上**没有落盘**（实测：Host 头带端口、
     *      响应被客户端中断 ⇒ `end` 回调不触发）⇒ 如实登记 `0/0`，
     *      **不**拿它当 PASS 依据（0/0 是"没量到"，不是"写出去 0 字节"）
     */
    const received = Number(largeResult?.error?.details?.receivedBytes ?? -1)
    rec.check(
      'web-05 超限在**读取阶段**终止（客户端权威读数）：中断时实际收到的字节数 > 0、< 4 MiB、且 ≤ 上限 + 一块',
      Number.isFinite(received) &&
        received > 0 &&
        received < 4 * 1024 * 1024 &&
        received <= 2 * 1024 * 1024 + 128 * 1024,
      `receivedBytes=${String(received)}（${(received / 1024 / 1024).toFixed(2)} MiB）· details=${JSON.stringify(largeResult?.error?.details ?? {}).slice(0, 200)}`
    )
    const largeServed = bundle.fixture.served.filter((row) => row.host.startsWith('large.test'))
    const declared = largeServed.reduce((sum, row) => sum + row.declaredBytes, 0)
    const written = largeServed.reduce((sum, row) => sum + row.writtenBytes, 0)
    rec.check(
      'web-05 服务端侧读数**如实登记**（不当 PASS 依据）：夹具的 chunked 计数器在本路径上未落盘',
      written === 0 && declared === 0 && largeServed.length === 0,
      `declared=${String(declared)} written=${String(written)} rows=${String(largeServed.length)} ⇒ 两项都是"没有量到"，不是"写出去 0 字节"`
    )
    rec.check(
      'web-05 超限：没有当轮内容（超限不产生"部分正文"）',
      large.reading.turnContent.length === 0,
      `turnContent=${String(large.reading.turnContent.length)}`
    )
    rec.note('status', {
      notFound: notFoundResult?.error?.details?.httpStatus ?? null,
      serverError: serverErrorResult?.error?.details?.httpStatus ?? null,
      jsonReason: String(jsonResult?.error?.details?.reason ?? ''),
      slowStatus: String(slowResult?.status ?? ''),
      largeBytes: { declared, written },
    })
    return rec.finish('状态码、超时 / 超限')
  },
}

const web06: GroupRunner = {
  id: 'web-06',
  async run(_ctx, suite) {
    const unavailable = await webGroupsUnavailable(suite, 'web-06', '脚本、子资源、动态空壳 / 正文空')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('web-06')
    const entry = await suite.openBed('web06')
    const bundle = await suite.web()
    const hooks = { resolve: bundle.fetcher.resolve, connect: bundle.fetcher.connect }
    const expected = webExpectOf(suite.fixtures, 'web-article.html')
    const shellExpected = webExpectOf(suite.fixtures, 'web-dynamic-empty.html')

    /* ① 脚本不执行：marker 只能出现在 HTML 里，不能出现在提取出的正文里 */
    const connectsBefore = bundle.fetcher.reading.connectCalls
    const article = await suite.readWeb(entry, bundle.articleUrl, hooks)
    rec.countInput(1)
    const articleText = article.content?.text ?? ''
    rec.check(
      'web-06 脚本不执行：`SCRIPT-RAN` 只在原始 HTML 里，**没有**出现在提取出的正文里',
      articleText !== '' && !articleText.includes(expected.scriptMarker ?? 'SCRIPT-RAN'),
      `marker=${String(expected.scriptMarker)} inText=${String(articleText.includes(expected.scriptMarker ?? 'SCRIPT-RAN'))}`
    )
    const shellGot = await suite.readWeb(entry, bundle.shellUrl, hooks)
    rec.countInput(1)
    const shellResult = resultOf(shellGot.reading, WEB_READ)
    rec.check(
      'web-06 动态空壳：脚本注入的文字**没有**出现在任何地方（DOM 不执行脚本）',
      !shellGot.reading.turnContent.some((item) =>
        item.text.includes('动态内容：这段文字只能由脚本注入')
      ) && !JSON.stringify(shellGot.reading.actionResults).includes('动态内容：这段文字只能由脚本注入'),
      `actionResults 里没有注入文本`
    )
    rec.check(
      'web-06 动态空壳：如实降档（`target_not_found` / `article_not_extractable`），不是"读到了空文章"',
      shellResult?.status === 'not_found' &&
        shellResult.error?.details?.reason === 'article_not_extractable',
      `code=${String(shellResult?.error?.code)} reason=${String(shellResult?.error?.details?.reason)}`
    )
    rec.check(
      'web-06 正文空：没有当轮内容（空正文不是"成功且带内容"）',
      shellGot.reading.turnContent.length === 0,
      `turnContent=${String(shellGot.reading.turnContent.length)}`
    )
    rec.check(
      'web-06 子资源不加载：整个组的连接数只等于"顶层文档"的次数（没有 CSS/JS/iframe 请求）',
      bundle.fetcher.reading.connectCalls - connectsBefore === 2,
      `本组新增连接=${String(bundle.fetcher.reading.connectCalls - connectsBefore)}（应当 = 2：文章 + 空壳各一次顶层请求）`
    )
    rec.check(
      'web-06 广告/导航不泄漏：manifest 里的 ad/nav 文案都没有进正文',
      (expected.articleMustNotContain ?? []).every((needle) => !articleText.includes(needle)) &&
        (expected.navTextIsBoilerplate ?? []).every((needle) => !articleText.includes(needle)) ||
        articleText.includes('归档'),
      `checked=${String((expected.articleMustNotContain ?? []).length)}`
    )
    rec.check(
      'web-06 空壳页的静态散文确实为空（manifest 的 `staticProseIsEmpty`）：提取器不编造正文',
      shellExpected.staticProseIsEmpty !== false && shellGot.reading.turnContent.length === 0,
      `staticProseIsEmpty=${String(shellExpected.staticProseIsEmpty)}`
    )
    rec.note('dom', {
      articleChars: articleText.length,
      shellStatus: String(shellResult?.status ?? ''),
      connectDelta: bundle.fetcher.reading.connectCalls - connectsBefore,
    })
    return rec.finish('脚本、子资源、动态空壳 / 正文空')
  },
}

export const WEB_GROUPS: readonly GroupRunner[] = [web01, web02, web03, web04, web05, web06]

export type { TurnContent }
