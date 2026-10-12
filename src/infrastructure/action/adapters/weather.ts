/**
 * `weather.query` 适配器（第二批计划 §3.1）。
 *
 * ============================================================================
 *  两步固定服务调用，一个能力
 * ============================================================================
 * ```text
 * ① Geocoding   GET https://geocoding-api.open-meteo.com/v1/search?name=…
 *               同名候选无法确定 ⇒ **先澄清**（不取第一条）
 * ② Forecast    GET https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…
 *               取当前 + 有限天数预报，带单位 / 时区 / 数据时间
 * ```
 * 计划书 §3.1：「地理编码与天气获取属于**一个具名天气动作**的两个固定服务步骤；
 * 首版不自动换多个 provider」。
 *
 * ============================================================================
 *  三条如实性要求
 * ============================================================================
 * ```text
 * · 请求只发必要城市/坐标与时间范围（不发用户原话、不发 userId）
 * · 结果必须带**预报有效时间、获取时间、单位、时区** —— "现在多少度"没有时间就是废话
 * · 当前天气来自所用天气模型的数据口径，**不能冒充**现场气象站实测
 * ```
 * ⚠️ 我们不读浏览器 GPS、不从聊天片段推断精确住址（计划书 §3.1 第 1 段逐字）。
 *
 * ⚠️ **网络出口**：本适配器用 `globalThis.fetch` 直连两个固定 HTTPS 主机。
 *    主机名是两个**常量**，路径参数只有城市名与坐标 ⇒ 不存在"按用户输入连任意主机"。
 */

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import {
  WEATHER_QUERY,
  WEATHER_QUERY_OPERATION,
} from '../../../kernel/action/weather-capability.ts'
import { TURN_CONTENT_LIMITS } from '../../../kernel/contracts/turn-content.ts'
import type { LocalTextTurnContent, TurnContent } from '../../../kernel/contracts/turn-content.ts'
import { fnv1a64Hex } from '../../../kernel/action/idempotency.ts'
import { createHash } from 'node:crypto'

/** 两个**固定**主机（不来自配置、不来自用户输入） */
export const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search'
export const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

export const WEATHER_LIMITS = {
  timeoutMs: 15_000,
  maxResponseBytes: 512 * 1024,
  maxDays: 7,
  /** 地理编码候选最多看几条（超过就要求澄清，**不**按第一条猜） */
  maxGeocodingCandidates: 10,
} as const

export interface WeatherAdapterOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

interface GeocodingPlace {
  name?: unknown
  latitude?: unknown
  longitude?: unknown
  country?: unknown
  admin1?: unknown
  admin2?: unknown
  timezone?: unknown
  /** Open-Meteo 给的常住人口（小村庄常常没有这个字段） */
  population?: unknown
  /** 地名类型码（`PPLC` 首都 / `PPLA` 一级行政区首府 / `PPLA2…` / `PPL` 一般聚落） */
  feature_code?: unknown
}

/**
 * "行政中心"类的地名类型码。
 *
 * ⚠️ 这个集合是**真读数逼出来的**（2026-10-04 的真模型 live）：
 *    第一版"候选多于 1 就必须澄清"让 **西安** 也变成 `target_ambiguous` ——
 *    真实的地理编码对"西安"返回 10 条：一条 `PPLA`（陕西省会，人口 960 万）
 *    与九条同名的**村庄**（`PPL` 或没有人口）。
 *    对用户而言那不是歧义，那是"我只想要那个省会"。
 * ⇒ 规则改成：**收窄之后恰好只有一个"行政中心"类候选 ⇒ 选它**，
 *    并把其余同名候选**列进 facts**（可核对的"我没选它们，原因是它们不是行政中心"）。
 *    两个都是行政中心（例如"朝阳"分属北京市 / 辽宁省）⇒ **仍然澄清**。
 */
const SEAT_FEATURE_CODES: readonly string[] = ['PPLC', 'PPLA', 'PPLA2', 'PPLG']

interface ForecastResponse {
  timezone?: unknown
  utc_offset_seconds?: unknown
  current?: Record<string, unknown>
  current_units?: Record<string, unknown>
  daily?: Record<string, unknown>
  daily_units?: Record<string, unknown>
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 一个候选地点的可读一行（进 facts，不进账本正文） */
export function describePlace(place: {
  name: string
  country?: string
  admin1?: string
  admin2?: string
  timezone?: string
  latitude: number
  longitude: number
}): string {
  const parts = [place.name]
  if (place.admin2 !== undefined) parts.push(place.admin2)
  if (place.admin1 !== undefined) parts.push(place.admin1)
  if (place.country !== undefined) parts.push(place.country)
  return `${parts.join(' / ')}（${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}${place.timezone !== undefined ? `, ${place.timezone}` : ''}）`
}

/**
 * 从地理编码候选里挑出**唯一**那个（挑不出来就如实要求澄清）。
 *
 * ⚠️ 判据是**结构性**的，不是"第一条最像"：
 * ```text
 * 0 个候选        ⇒ not_found（"没找到这个地名"）
 * 1 个候选        ⇒ 用它
 * 多个候选 + 用户给了国家/行政区 ⇒ 在那个子集里再判一次
 * 仍多于一个      ⇒ **ambiguous**（"同名候选有几个，你指哪一个？"）
 * ```
 * 计划书 §3.1 逐字："同名候选无法确定时先澄清，不取第一条"。
 */
export function pickPlace(
  candidates: readonly GeocodingPlace[],
  hints: { country?: string; admin?: string }
):
  | {
      place: GeocodingPlace
      confidence: 'exact' | 'strong'
      /** 没被选中的同名候选（进 facts；**不是**静默丢弃） */
      others: readonly GeocodingPlace[]
    }
  | { reason: 'none' | 'ambiguous'; count: number; sample: string[] } {
  const usable = candidates.filter(
    (item) => typeof item.name === 'string' && finiteNumber(item.latitude) !== undefined && finiteNumber(item.longitude) !== undefined
  )
  if (usable.length === 0) return { reason: 'none', count: 0, sample: [] }
  if (usable.length === 1) return { place: usable[0]!, confidence: 'exact', others: [] }

  const countryHint = hints.country?.trim().toLowerCase()
  const adminHint = hints.admin?.trim().toLowerCase()
  let narrowed = usable
  if (countryHint !== undefined && countryHint !== '') {
    const byCountry = narrowed.filter(
      (item) => (str(item.country) ?? '').toLowerCase().includes(countryHint)
    )
    if (byCountry.length > 0) narrowed = byCountry
  }
  if (adminHint !== undefined && adminHint !== '') {
    const byAdmin = narrowed.filter(
      (item) =>
        (str(item.admin1) ?? '').toLowerCase().includes(adminHint) ||
        (str(item.admin2) ?? '').toLowerCase().includes(adminHint)
    )
    if (byAdmin.length > 0) narrowed = byAdmin
  }
  if (narrowed.length === 1) return { place: narrowed[0]!, confidence: 'strong', others: [] }

  /*
   * 收窄之后仍多于一个：**只有当"行政中心"类候选恰好一个时**才替用户定下来。
   * 其余情况一律澄清（那是"同名"的真实歧义，例如两个省级以下的同名城区）。
   */
  const seats = narrowed.filter((item) => SEAT_FEATURE_CODES.includes(str(item.feature_code) ?? ''))
  if (seats.length === 1) {
    const chosen = seats[0]!
    return {
      place: chosen,
      confidence: 'strong',
      others: narrowed.filter((item) => item !== chosen),
    }
  }
  return {
    reason: 'ambiguous',
    count: narrowed.length,
    sample: narrowed
      .slice(0, WEATHER_LIMITS.maxGeocodingCandidates)
      .map((item) => `${str(item.name) ?? '?'}（${str(item.admin1) ?? ''}${str(item.admin1) !== undefined && str(item.country) !== undefined ? ', ' : ''}${str(item.country) ?? ''}）`),
  }
}

export function createWeatherAdapter(options: WeatherAdapterOptions = {}): CapabilityAdapter {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? WEATHER_LIMITS.timeoutMs
  const now = options.now ?? (() => Date.now())

  async function getJson(url: string): Promise<{ ok: true; body: unknown; bytes: number } | { ok: false; reason: 'timeout' | 'http_error' | 'bad_body'; status?: number }> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) return { ok: false, reason: 'http_error', status: response.status }
      const text = await response.text()
      if (text.length > WEATHER_LIMITS.maxResponseBytes) {
        return { ok: false, reason: 'bad_body' }
      }
      try {
        return { ok: true, body: JSON.parse(text) as unknown, bytes: text.length }
      } catch {
        return { ok: false, reason: 'bad_body' }
      }
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'http_error' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    capabilityId: WEATHER_QUERY,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const city = (stringArg(input.args, 'city') ?? '').trim()
      if (city === '') {
        throw new ActionFailureError(
          actionFailure('validation_failed', '没有给出城市名 —— 不猜地点（也不从聊天片段推断住址）')
        )
      }
      const country = stringArg(input.args, 'country')
      const daysRaw = input.args.days
      const days =
        typeof daysRaw === 'number' && Number.isFinite(daysRaw)
          ? Math.min(Math.max(Math.trunc(daysRaw), 1), WEATHER_LIMITS.maxDays)
          : 3

      /*
       * ① 地理编码。计划书 §3.1：请求**只发必要城市名**（不发用户原话）。
       *    `count` 明确要多个候选 —— 一个候选不足以判断"同名有没有别的"。
       */
      const geoUrl =
        `${GEOCODING_ENDPOINT}?name=${encodeURIComponent(city)}` +
        `&count=${String(WEATHER_LIMITS.maxGeocodingCandidates)}&language=zh&format=json`
      const geo = await getJson(geoUrl)
      if (!geo.ok) {
        throw new ActionFailureError(
          actionFailure(
            geo.reason === 'timeout' ? 'timeout' : 'execution_failed',
            geo.reason === 'timeout'
              ? `天气服务在 ${String(timeoutMs)}ms 内没有返回（地理编码那一步）`
              : `地理编码请求失败（${geo.reason}${geo.status !== undefined ? ` ${String(geo.status)}` : ''}）`
          )
        )
      }
      const geoBody = geo.body as { results?: unknown }
      const results = Array.isArray(geoBody.results) ? (geoBody.results as GeocodingPlace[]) : []
      const picked = pickPlace(results, {
        ...(country !== undefined ? { country } : {}),
      })
      if ('reason' in picked) {
        if (picked.reason === 'none') {
          throw new ActionFailureError(
            actionFailure('target_not_found', `没找到叫「${city}」的地点（地理编码返回 0 个候选）`)
          )
        }
        throw new ActionFailureError(
          actionFailure(
            'target_ambiguous',
            `「${city}」有 ${String(picked.count)} 个同名候选，无法确定是哪一个：` +
              `${picked.sample.join(' / ')} —— 请说清是哪一个（国家 / 省份），我不取第一条`
          )
        )
      }
      const place = picked.place
      const latitude = finiteNumber(place.latitude)!
      const longitude = finiteNumber(place.longitude)!
      const timezoneHint = str(input.args.timezone) ?? str(place.timezone) ?? 'auto'

      // ② 预报（固定域名 + 固定字段组；参数只有坐标与天数）
      const forecastUrl =
        `${FORECAST_ENDPOINT}?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}` +
        `&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
        `&forecast_days=${String(days)}&timezone=${encodeURIComponent(timezoneHint)}`
      const forecast = await getJson(forecastUrl)
      if (!forecast.ok) {
        throw new ActionFailureError(
          actionFailure(
            forecast.reason === 'timeout' ? 'timeout' : 'execution_failed',
            forecast.reason === 'timeout'
              ? `天气服务在 ${String(timeoutMs)}ms 内没有返回（预报那一步）`
              : `天气请求失败（${forecast.reason}${forecast.status !== undefined ? ` ${String(forecast.status)}` : ''}）`
          )
        )
      }
      const body = forecast.body as ForecastResponse
      const timezone = str(body.timezone) ?? timezoneHint
      const utcOffset = finiteNumber(body.utc_offset_seconds)

      const current = body.current ?? {}
      const currentUnits = body.current_units ?? {}
      const daily = body.daily ?? {}
      const dailyUnits = body.daily_units ?? {}

      const currentLines: string[] = []
      const pushCurrent = (key: string, label: string): void => {
        const value = finiteNumber(current[key])
        if (value === undefined) return
        const unit = str(currentUnits[key]) ?? ''
        currentLines.push(`${label}：${String(value)}${unit}`)
      }
      pushCurrent('temperature_2m', '气温')
      pushCurrent('apparent_temperature', '体感')
      pushCurrent('precipitation', '降水')
      pushCurrent('wind_speed_10m', '风速')
      const codeNow = finiteNumber(current.weather_code)
      if (codeNow !== undefined) currentLines.push(`天气代码：${String(codeNow)}`)

      const times = Array.isArray(daily.time) ? (daily.time as unknown[]) : []
      const maxes = Array.isArray(daily.temperature_2m_max) ? (daily.temperature_2m_max as unknown[]) : []
      const mins = Array.isArray(daily.temperature_2m_min) ? (daily.temperature_2m_min as unknown[]) : []
      const rains = Array.isArray(daily.precipitation_sum) ? (daily.precipitation_sum as unknown[]) : []
      const codes = Array.isArray(daily.weather_code) ? (daily.weather_code as unknown[]) : []
      const dailyLines: string[] = []
      for (let index = 0; index < times.length; index += 1) {
        const date = typeof times[index] === 'string' ? (times[index] as string) : `第${String(index + 1)}天`
        const max = finiteNumber(maxes[index])
        const min = finiteNumber(mins[index])
        const rain = finiteNumber(rains[index])
        const code = finiteNumber(codes[index])
        const unit = str(dailyUnits.temperature_2m_max) ?? ''
        dailyLines.push(
          `${date}：${min !== undefined ? String(min) : '?'}~${max !== undefined ? String(max) : '?'}${unit}` +
            `${rain !== undefined ? ` · 降水 ${String(rain)}${str(dailyUnits.precipitation_sum) ?? ''}` : ''}` +
            `${code !== undefined ? ` · 天气代码 ${String(code)}` : ''}`
        )
      }

      const fetchedAt = now()
      const observedAt = str(current.time) ?? undefined
      const placeText = describePlace({
        name: str(place.name) ?? city,
        ...(str(place.country) !== undefined ? { country: str(place.country)! } : {}),
        ...(str(place.admin1) !== undefined ? { admin1: str(place.admin1)! } : {}),
        ...(str(place.admin2) !== undefined ? { admin2: str(place.admin2)! } : {}),
        ...(timezone !== '' ? { timezone } : {}),
        latitude,
        longitude,
      })

      const facts = [
        `地点：${placeText}`,
        `时区：${timezone}${utcOffset !== undefined ? `（UTC${utcOffset >= 0 ? '+' : ''}${String(utcOffset / 3600)}）` : ''}`,
        `预报有效时间（服务给出的观测/预报时刻）：${observedAt ?? '服务未给出'}`,
        `获取时间：${new Date(fetchedAt).toISOString()}`,
        `预报天数：${String(times.length)}（请求 ${String(days)}）`,
        '数据来源：Open-Meteo（**天气模型数据**，不是现场气象站实测）',
        `地理编码候选数：${String(results.length)} · 选定依据：${
          picked.confidence === 'exact'
            ? '唯一候选'
            : picked.others.length > 0
              ? '同名候选中**只有一个行政中心**，因此选定它（其余候选见下一行）'
              : '用户给的国家/行政区收窄到唯一'
        }`,
        /*
         * ⚠️ 同名的**其它**候选要列出来（不是静默丢弃）：用户必须能回答
         *    "为什么是这一个"。这是"选定依据"那句话的**可核对形式**。
         */
        ...(picked.others.length > 0
          ? [
              `同名但未选中的候选（${String(picked.others.length)} 个）：${picked.others
                .slice(0, 5)
                .map((item) => `${str(item.name) ?? '?'}（${str(item.admin1) ?? str(item.country) ?? '?'}）`)
                .join(' · ')}`,
            ]
          : []),
      ]

      const text = [
        `城市：${str(place.name) ?? city}（${placeText}）`,
        '',
        '当前：',
        ...(currentLines.length > 0 ? currentLines : ['（服务没有返回当前字段）']),
        '',
        `接下来 ${String(times.length)} 天：`,
        ...(dailyLines.length > 0 ? dailyLines : ['（服务没有返回逐日字段）']),
      ].join('\n')

      const shaped = text.slice(0, TURN_CONTENT_LIMITS.maxTextChars)
      const content: LocalTextTurnContent = {
        contentId: `${String(input.actionId)}:weather`,
        kind: 'local-text',
        capability: WEATHER_QUERY,
        operation: WEATHER_QUERY_OPERATION,
        sourceKind: 'remote-service',
        resourceRef: forecastUrl,
        sourceFingerprint: sha256(JSON.stringify(forecast.body)),
        resultFingerprint: fnv1a64Hex(text),
        scope: {
          totalChars: text.length,
          includedChars: shaped.length,
          truncated: shaped.length < text.length,
        },
        facts,
        text: shaped,
        mediaType: 'application/x-weather-report',
        lineCount: shaped.split('\n').length,
        sourceBytes: forecast.bytes,
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: 'content_read',
          detail: `天气：${str(place.name) ?? city}（当前 + ${String(times.length)} 天）`,
          fingerprint: content.resultFingerprint,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `weather.query（两跳固定服务）地点=${str(place.name) ?? city} ` +
              `时区=${timezone} 天数=${String(times.length)} 获取时间=${new Date(fetchedAt).toISOString()}`,
            ref: str(place.name) ?? city,
          },
        ],
        turnContent,
      }
    },
  }
}
