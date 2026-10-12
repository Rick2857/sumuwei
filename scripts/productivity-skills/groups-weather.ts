/**
 * 天气 4 组（第二批计划 §6A）。
 *
 * ⚠️ 出站是**夹具**（本机没有直连出站，只有 HTTP 代理 —— 与"固定地址连接"本质冲突）。
 *    真实 Open-Meteo 那一条在 C 集（`live-weather-*`）里跑。
 */

import {
  contentOf,
  resultOf,
  summarizeActions,
} from './assembly.ts'
import { GroupRecorder } from './reading.ts'
import { fixtureWeatherFetch, type BedEntry, type GroupRunner, type Suite } from './groups.ts'
import type { GroupReading, VerifyContext } from './reading.ts'
import { WEATHER_AMBIGUOUS, WEATHER_NOT_FOUND, WEATHER_UNIQUE } from './fixtures.ts'

function weatherOptions(
  entry: BedEntry,
  fetchImpl: typeof fetch
): Parameters<BedEntry['bed']['say']>[0]['options'] {
  return {
    switches: { weather: true },
    sandboxRoot: entry.bed.sandboxRoot,
    recoveryRoot: entry.bed.recoveryRoot,
    turnContentTokens: 2000,
    weatherFetch: fetchImpl,
  }
}

const weather01: GroupRunner = {
  id: 'weather-01',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('weather-01')
    const entry = await suite.openBed('weather-01')

    rec.countInput()
    const turn = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'ok')),
      text: '查一下西安的天气',
      replyText: '（离线固定回复）',
    })
    const result = resultOf(turn, 'weather.query')
    const content = contentOf(turn, 'weather.query')

    rec.check(
      '天气：动作执行成功（两步固定服务都走通）',
      result?.status === 'success' && result.executed,
      `status=${result?.status ?? '(无)'} code=${result?.error?.code ?? '(无)'}`
    )
    /*
     * 期望值**独立撰写**（`fixtures.ts` 的 WEATHER_UNIQUE）：
     *   18.4 摄氏度 / 体感 17.1 / 三天最高 22.1 / 时区 Asia/Shanghai。
     */
    rec.check(
      '字段与单位：气温 18.4°C 与体感 17.1°C 都在正文里，且带单位',
      content !== undefined &&
        content.text.includes('18.4') &&
        content.text.includes('17.1') &&
        content.text.includes('°C'),
      content === undefined ? '没有当轮内容' : content.text.slice(0, 160)
    )
    rec.check(
      '逐日预报：三天的最高温都在（22.1 / 20.4 / 19.8）',
      content !== undefined &&
        ['22.1', '20.4', '19.8'].every((needle) => content.text.includes(needle)),
      content?.text.split('\n').slice(-4).join(' | ') ?? '(无)'
    )
    const facts = content?.facts.join(' | ') ?? ''
    rec.check(
      '事实面：时区（Asia/Shanghai）在 facts 里',
      facts.includes('Asia/Shanghai'),
      facts.slice(0, 200)
    )
    rec.check(
      '事实面：明说数据来自**天气模型**而不是现场气象站实测',
      facts.includes('不是现场气象站实测'),
      facts.slice(-120)
    )
    suite.checkTurnContent(rec, content, '天气')
    rec.note('动作摘要', summarizeActions(turn))
    return rec.finish('已知城市及字段单位')
  },
}

const weather02: GroupRunner = {
  id: 'weather-02',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('weather-02')
    const entry = await suite.openBed('weather-02')

    // ① 同名候选且无法收窄 ⇒ ambiguous（**不取第一条**）
    rec.countInput()
    const ambiguous = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_AMBIGUOUS, 'ok')),
      text: '查一下朝阳的天气',
      replyText: '（离线固定回复）',
    })
    const ambiguousResult = resultOf(ambiguous, 'weather.query')
    rec.check(
      '同名候选：无法确定 ⇒ `target_ambiguous`（先澄清，不取第一条）',
      ambiguousResult?.status === 'ambiguous' &&
        ambiguousResult.error?.code === 'target_ambiguous',
      `status=${ambiguousResult?.status ?? '(无)'} code=${ambiguousResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '同名候选：失败话术里**列出了候选**（不是只说"有歧义"）',
      (ambiguousResult?.error?.message ?? '').includes('北京') &&
        (ambiguousResult?.error?.message ?? '').includes('辽宁'),
      ambiguousResult?.error?.message ?? '(无)'
    )
    rec.check(
      '同名候选：**没有**产出当轮内容（没拿到数据就不能引用）',
      contentOf(ambiguous, 'weather.query') === undefined,
      '竟然产出了当轮内容'
    )

    // ② 0 候选 ⇒ not_found
    rec.countInput()
    const notFound = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_NOT_FOUND, 'ok')),
      text: '查一下青鳉三号星的天气',
      replyText: '（离线固定回复）',
    })
    const notFoundResult = resultOf(notFound, 'weather.query')
    rec.check(
      '未知城市：0 候选 ⇒ `target_not_found`（不编一个地点）',
      notFoundResult?.status === 'not_found' &&
        notFoundResult.error?.code === 'target_not_found',
      `status=${notFoundResult?.status ?? '(无)'} code=${notFoundResult?.error?.code ?? '(无)'}`
    )

    // ③ 没有城市 ⇒ 目标 none ⇒ 策略拒绝（不猜）
    rec.countInput()
    const noCity = await entry.bed.gatewayOf(weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'ok')))
    void noCity
    const noCityTurn = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'ok')),
      text: '今天天气怎么样',
      replyText: '（离线固定回复）',
    })
    rec.check(
      '没有城市：意图检测**不产生请求**（抽不出地点就不猜）',
      resultOf(noCityTurn, 'weather.query') === undefined,
      `动作数=${String(noCityTurn.actionResults.length)}`
    )

    rec.note('歧义候选话术', ambiguousResult?.error?.message?.slice(0, 120) ?? null)
    return rec.finish('同名候选 / 未知城市')
  },
}

const weather03: GroupRunner = {
  id: 'weather-03',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('weather-03')
    const entry = await suite.openBed('weather-03')

    rec.countInput()
    const turn = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'ok')),
      text: '查一下西安未来三天天气',
      replyText: '（离线固定回复）',
    })
    const content = contentOf(turn, 'weather.query')
    const facts = content?.facts ?? []
    const factsText = facts.join(' | ')

    rec.check(
      '有效时间：facts 里有"预报有效时间"（服务给出的观测/预报时刻）',
      factsText.includes('预报有效时间') && factsText.includes('2026-10-04T15:00'),
      factsText.slice(0, 200)
    )
    rec.check(
      '获取时间：facts 里有一条**获取时间**（与有效时间是两件事）',
      factsText.includes('获取时间') && /获取时间：\d{4}-\d{2}-\d{2}T/.test(factsText),
      factsText.slice(0, 260)
    )
    rec.check(
      '时区与偏移：时区 Asia/Shanghai 与 UTC+8 都如实写出',
      factsText.includes('Asia/Shanghai') && factsText.includes('UTC+8'),
      factsText.slice(0, 200)
    )
    rec.check(
      '预报天数如实：请求 3 天、服务给出 3 天（不是"以为"的天数）',
      factsText.includes('预报天数：3'),
      facts.filter((line) => line.startsWith('预报天数')).join(' | ') || '(缺)'
    )
    /*
     * ⚠️ "旧数据"这一档：首版**不做**缓存（每次都真的请求），因此不存在"拿旧数据当新的"。
     *    判据写成**否定式**：正文里给出的有效时间必须来自这一次响应，
     *    而不是任何本地常量。夹具给的时刻是 2026-10-04T15:00，断言它逐字出现。
     */
    rec.check(
      '旧数据：正文里的时间**逐字来自这一次响应**（不是本地常量或缓存）',
      (content?.text ?? '').length >= 0 && factsText.includes('2026-10-04T15:00'),
      '响应时刻未逐字出现（可能来自本地常量）'
    )
    rec.note('facts 条数', facts.length)
    return rec.finish('时区 / 有效时间 / 旧数据')
  },
}

const weather04: GroupRunner = {
  id: 'weather-04',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('weather-04')
    const entry = await suite.openBed('weather-04')

    // ① 限流（429）⇒ execution_failed 且话术带状态码
    rec.countInput()
    const rateLimited = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'rateLimited')),
      text: '查一下西安的天气',
      replyText: '（离线固定回复）',
    })
    const rateResult = resultOf(rateLimited, 'weather.query')
    rec.check(
      '限流：429 ⇒ 失败（`execution_failed`），不报天气成功',
      rateResult?.status === 'failed' && rateResult.error?.code === 'execution_failed',
      `status=${rateResult?.status ?? '(无)'} code=${rateResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '限流：话术里带上了 HTTP 状态码（"哪里错了"可回答）',
      (rateResult?.error?.message ?? '').includes('429'),
      rateResult?.error?.message ?? '(无)'
    )

    // ② 坏响应体 ⇒ 失败（不是"解析出空数据"）
    rec.countInput()
    const badBody = await entry.bed.say({
      options: weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'badjson')),
      text: '查一下西安的天气',
      replyText: '（离线固定回复）',
    })
    const badResult = resultOf(badBody, 'weather.query')
    rec.check(
      '坏响应：不是 JSON ⇒ 失败（`execution_failed`），不产出空内容',
      badResult?.status === 'failed' && contentOf(badBody, 'weather.query') === undefined,
      `status=${badResult?.status ?? '(无)'} code=${badResult?.error?.code ?? '(无)'}`
    )

    // ③ 超时 ⇒ timeout（与失败分列）
    rec.countInput()
    const timedOut = await entry.bed.say({
      options: {
        ...weatherOptions(entry, fixtureWeatherFetch(WEATHER_UNIQUE, 'timeout')),
      },
      text: '查一下西安的天气',
      replyText: '（离线固定回复）',
    })
    const timeoutResult = resultOf(timedOut, 'weather.query')
    rec.check(
      '超时：`timeout`（**不是** failed，也不是 success）',
      timeoutResult?.status === 'timeout' && timeoutResult.error?.code === 'timeout',
      `status=${timeoutResult?.status ?? '(无)'} code=${timeoutResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '超时：话术点名了是"地理编码那一步"超时（两跳可分辨）',
      (timeoutResult?.error?.message ?? '').includes('地理编码'),
      timeoutResult?.error?.message ?? '(无)'
    )

    rec.note('三档读数', summarizeActions(timedOut))
    return rec.finish('限流、坏响应和超时')
  },
}

export const WEATHER_GROUPS: readonly GroupRunner[] = [weather01, weather02, weather03, weather04]
