/**
 * DiagnosticProjection —— M2.5 的**纯测试**纵切。
 *
 * ============================================================================
 *  为什么需要一个"没用的"投影
 * ============================================================================
 * M2.5 不实现 Relationship / Affect / Belief / Goals / Adaptive Self。
 * 但整条链
 *
 *     Proposal → Validator → DomainEvent → Reducer → Projection
 *
 * 必须在 M2.5 就**真的跑通**，而不是等到 M7 才第一次运行。
 * 否则「架构是否成立」只是一个说法。
 *
 * 所以这里放一个最小的、可验证的计数器投影：
 *
 *     DomainEvent: TEST_CHARACTER_SIGNAL { counterDelta: number }
 *              ↓
 *     DiagnosticProjection.state.counter
 *
 * 它的行为必须足够无聊（加法），这样任何意外都只会来自**链路**，
 * 而不是来自算法本身。
 *
 * ⚠️ **生产行为不得依赖 DiagnosticProjection**（plan 第 17 节）。
 *    它只被测试、diagnostic processor、以及 `--kernel-status` 这类调试入口使用。
 */

import type { DomainEvent, ProjectionReducer } from '../contracts/index.ts'
import { DIAGNOSTIC_SIGNAL, defaultIsStale, type DiagnosticSignalPayload } from '../contracts/index.ts'

export const DIAGNOSTIC_PROJECTION_TYPE = 'diagnostic-counter' as const

/**
 * Reducer 版本。
 *
 * 改动 `reduce` 的任何语义都必须改这里——plan 第 24/29 节：
 * 不允许用新算法偷偷继续更新旧 Projection，必须显式升级版本并 rebuild。
 */
export const DIAGNOSTIC_REDUCER_VERSION = 'diagnostic-reducer@1' as const

export interface DiagnosticState {
  /** 折叠过的诊断信号次数 */
  counter: number

  /**
   * 每次都记录的最后一条 payload。
   *
   * 保留它不是为了业务，而是为了让 Replay 的**等价性**可以被逐字段比对：
   * 只有 counter 的话，"少 reduce 了一条 +1 又 -1 的事件"看不出来。
   */
  lastDelta?: number

  /** 累计 payload 字节数（用于验证"payload 上限"这条策略真的生效） */
  payloadBytes: number
}

export function createDiagnosticReducer(): ProjectionReducer<DiagnosticState> {
  return {
    projectionType: DIAGNOSTIC_PROJECTION_TYPE,
    version: DIAGNOSTIC_REDUCER_VERSION,
    handledEventTypes: [DIAGNOSTIC_SIGNAL],

    initialState(): DiagnosticState {
      return { counter: 0, payloadBytes: 0 }
    },

    reduce(state: DiagnosticState, event: DomainEvent): DiagnosticState {
      if (event.type !== DIAGNOSTIC_SIGNAL) return state

      const payload = event.payload as DiagnosticSignalPayload
      return {
        counter: state.counter + payload.counterDelta,
        lastDelta: payload.counterDelta,
        payloadBytes: state.payloadBytes + JSON.stringify(payload).length,
      }
    },

    /** 默认单调判定：序号不大于当前的事件一律视为过时（乱序 Worker 保护） */
    isStale(projection, event) {
      return defaultIsStale(projection, event)
    },
  }
}
