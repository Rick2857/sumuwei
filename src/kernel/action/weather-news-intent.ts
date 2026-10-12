/**
 * 天气能力与资讯能力的**意图检测**（第二批计划 §3.1 / §3.3）。
 *
 * ============================================================================
 *  两条刻意的"不抢别人活"的边界
 * ============================================================================
 * ```text
 * 天气：需要句中真的有**天气词**（天气 / 气温 / 温度 / 下雨 / 降雨 / 预报 / 几度）
 *       AND 有一个城市/地点样的对象。抽不出地点 ⇒ 不产生请求
 *       （计划书 §3.1："用户明确城市或使用已设定城市时先走地理编码"——
 *         首版没有"已设定城市"，因此没有地点就不猜）
 *
 * 资讯：需要句中真的有**订阅来源词**（RSS / Atom / 订阅源 / feed）**或一个订阅源 URL**。
 *       ⚠️ 只说"最新消息 / 今天有什么新闻"**不触发资讯** —— 那归 M5.5 的联网搜索
 *          （计划书 §3.3 末段："无订阅源时复用现有搜索能力查询"）。
 *          把两者混起来会让"搜一下"变成"读一个我们并不知道的订阅源"。
 * ```
 */

import type { ActionIntent, ActionIntentDetector } from './intent-detector.ts'
import {
  NEWS_READ,
  NEWS_READ_OPERATION,
} from './news-capability.ts'
import { WEATHER_QUERY, WEATHER_QUERY_OPERATION } from './weather-capability.ts'

const WEATHER_WORDS = /(天气|气温|温度|下雨|降雨|降雪|晴天|阴天|多云|预报|几度|多少度|冷不冷|热不热|风力)/
const NEWS_WORDS = /(rss|atom|订阅源|订阅feed|feed|资讯源)/i

/**
 * 地点 token 的判据：**必须紧贴在天气词之前**。
 *
 * ```text
 * 查一下西安的天气        ⇒ 西安       （先削掉前缀动词，再要求"地点 + 的? + 天气词"）
 * 今天天气怎么样          ⇒ 无         （"今天"是时间词，不是地点）
 * 帮我看看上海明天天气     ⇒ 上海
 * Beijing weather         ⇒ Beijing
 * ```
 * ⚠️ 判据刻意**窄**：抽不出地点 ⇒ **不产生请求**（计划书 §3.1："用户明确城市或使用
 *    已设定城市时先走地理编码"）。宽一点的抓法会把"查一下西安的天气"整句当成城市名 ——
 *    那正好是"猜一个地点"。
 */
const LEADING_VERBS =
  /^(查一下|查查|查|看看|看一下|帮我查|帮我看看|帮我|问一下|告诉我|了解一下|今天|明天|后天|现在|最近|这周|本周|下周)+/

const CITY_BEFORE_WEATHER =
  /^([\u4e00-\u9fa5]{2,8}?)(?:市|区|县|镇|省)?(?:的)?(?:天气|气温|温度|预报|下雨|降雨|降雪|多少度|几度|冷不冷|热不热|风力)/
const CITY_LATIN =
  /^([A-Za-z][A-Za-z .'-]{1,30}?)(?:'s)?\s*(?:weather|forecast|temperature)/i
/** 句中出现"…的天气"时，取它前面那一段的**尾部**地名样片段 */
const CITY_ANYWHERE =
  /([\u4e00-\u9fa5]{2,8}?)(?:市|区|县|镇|省)?(?:的)?(?:天气|气温|温度|预报|下雨|降雨|降雪)/

/**
 * 明显的**非**地名词。
 *
 * ⚠️ 它是一道**否定**闸，不是"候选表"：判据仍然是"地点必须紧贴在天气词之前"，
 *    这张表只是把时间词与泛问词挡掉（"今天天气"里的"今天"）。
 */
const NON_CITY = new Set([
  '明天',
  '今天',
  '后天',
  '昨天',
  '现在',
  '最近',
  '这周',
  '本周',
  '下周',
  '天气',
  '气温',
  '温度',
  '预报',
  '下雨',
  '降雨',
  '怎么样',
  '如何',
  '多少',
  '几度',
  '查询',
  '查一下',
  '看看',
  '帮我',
  '我们',
  '这里',
  '那里',
  '本地',
  '当地',
])

export function extractCityToken(text: string): string | undefined {
  const stripped = text.trim().replace(LEADING_VERBS, '').trim()
  for (const candidate of [stripped, text.trim()]) {
    const latin = CITY_LATIN.exec(candidate)
    if (latin?.[1] !== undefined) {
      const token = latin[1].trim()
      if (token.length >= 2 && !NON_CITY.has(token)) return token
    }
    const direct = CITY_BEFORE_WEATHER.exec(candidate)
    if (direct?.[1] !== undefined && !NON_CITY.has(direct[1])) return direct[1]
  }
  for (const source of [stripped, text]) {
    const anywhere = CITY_ANYWHERE.exec(source)
    if (anywhere?.[1] !== undefined && !NON_CITY.has(anywhere[1])) return anywhere[1]
  }
  return undefined
}

export interface WeatherNewsIntentOptions {
  readonly weather: boolean
  readonly news: boolean
}

export function createWeatherIntentDetector(
  options: WeatherNewsIntentOptions
): ActionIntentDetector {
  return {
    detect(text: string): ActionIntent | undefined {
      const trimmed = text.trim()
      if (trimmed === '') return undefined

      // ① 天气：天气词 + 城市样 token（二者缺一不可）
      if (options.weather && WEATHER_WORDS.test(trimmed)) {
        const city = extractCityToken(trimmed)
        if (city !== undefined) {
          return {
            capability: WEATHER_QUERY,
            operation: WEATHER_QUERY_OPERATION,
            args: { city },
            hints: [],
            rule: 'weather_city',
            phrase: trimmed.slice(0, 60),
          }
        }
      }

      // ② 资讯：订阅来源词（或一个明显的 feed URL）。**不**认"最新消息"这类泛词。
      if (options.news && NEWS_WORDS.test(trimmed)) {
        /*
         * ⚠️ 这里同时收 `http://` 与 `https://` —— 刻意**不是**漏收：
         *    "只有 HTTPS"这条判据属于**适配器的准入**（复用 `web.read` 那一套）。
         *    在检测层就把 http 挡掉，用户得到的会是"她装作没听懂"，
         *    而不是一条**可审计的**"这个地址不被接受（not_https）"。
         */
        const urls = trimmed.match(/https?:\/\/[^\s"'<>，。；、）】》]+/g) ?? []
        const feedUrl = urls.find((url) => /(rss|atom|feed|\.xml)/i.test(url))
        if (feedUrl !== undefined) {
          return {
            capability: NEWS_READ,
            operation: NEWS_READ_OPERATION,
            args: { feeds: [feedUrl] },
            hints: [],
            rule: 'news_feed_url',
            phrase: trimmed.slice(0, 60),
          }
        }
        // 有订阅词但没有地址 ⇒ **不产生请求**（我们不猜一个订阅源）
      }
      return undefined
    },
  }
}
