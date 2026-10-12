/**
 * 天气能力的登记（第二批计划 §3.1 / §4 能力影响矩阵）。
 *
 * ```text
 * weather.query   weather:query   R1  read
 * ```
 * `read` 的风险下限是 `R0`，这里声明 `R1` 是**刻意抬高**的那一档
 * （先例：`web.read` / `web.search` 同为出站读，也声明 R1）。
 *
 * ============================================================================
 *  一个能力，两个固定服务步骤
 * ============================================================================
 * 计划书 §3.1 逐字：「地理编码与天气获取属于**一个具名天气动作**的两个固定服务步骤；
 * 首版不自动换多个 provider」。
 * ⇒ 登记表里只有**一个** capability、**一个** operation；
 *    "先 geocoding 再 forecast"是适配器内部的两步，**不是**两个可被单独请求的动作。
 *    这样模型就没有"只跑 geocoding"这种半成品请求可以发。
 */

import type { CapabilityDefinition } from './capability-registry.ts'

export const WEATHER_QUERY = 'weather.query'
export const WEATHER_QUERY_OPERATION = 'forecast'
export const WEATHER_QUERY_PERMISSION = 'weather:query'

export const WEATHER_CAPABILITY_IDS: readonly string[] = [WEATHER_QUERY]

export function isWeatherCapability(capabilityId: string): boolean {
  return WEATHER_CAPABILITY_IDS.includes(capabilityId)
}

export function weatherCapabilityLabel(capabilityId: string): string {
  return capabilityId === WEATHER_QUERY ? '天气查询' : capabilityId
}

export function createWeatherCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: WEATHER_QUERY,
      version: `${WEATHER_QUERY}@1`,
      description:
        '按城市名解析出**唯一**地点（地理编码），再取该地点的当前天气与有限天数预报；' +
        '结果带单位、时区、数据时间与来源。同名候选无法确定时**先澄清**，不取第一条。',
      operations: [
        {
          name: WEATHER_QUERY_OPERATION,
          description: '把 city（可带国家/行政区提示）解析成地点并取回天气',
          sideEffect: 'read',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [WEATHER_QUERY_PERMISSION],
      supportsDryRun: true,
      /*
       * 与第一批四项同一条理由：账本只存引用。若声明幂等，"重放上一次成功"
       * 会拿**旧天气**当**当前天气**回答 —— 那是一次说错事实，不是一次失败的读取。
       */
      idempotency: 'none',
    },
  ]
}
