/**
 * TelemetryRecorder —— 把 Character Kernel 的一轮生命周期接到 TelemetryPort 上。
 *
 * ============================================================================
 *  它与 TraceWriter 的分工
 * ============================================================================
 *
 *   TraceWriter（业务）  → character_traces 表。**永远可用**，是权威证据。
 *   TelemetryPort（导出）→ Phoenix 等后端。**可以缺失**，丢的只是可视化。
 *
 * 本文件是两者之间的桥：把已经落库的 `CharacterRunTrace` 镜像成 span。
 * 因此即使 Phoenix 整晚离线，事后仍然能从 `character_traces` 里补推。
 *
 * 全部方法是 **fire-and-forget 且不抛异常**：
 * 遥测出问题只允许出现在日志里，不允许出现在她的对话里（plan 第 49/96 节）。
 */

/*
 * ⚠️ `logger` 已从 ElizaOS 独立出来（M12 · W2）。
 * ⚠️ 行为**与上游同形**：默认 sink 写 stdout/stderr（上游 `info`→stdout、`warn`/`error`→stderr，
 *    2026-10-19 实测）。"日志去了哪"由 `recentLogs()` / `setLogSink()` 可查 —— 见 logger.ts 的说明。
 */
import { logger } from './logger.ts'

import type { CharacterRunTrace, TraceId, TraceStep } from '../../kernel/contracts/index.ts'
import type { TelemetryPort, TraceHandle } from './port.ts'

export class TelemetryRecorder {
  private readonly port: TelemetryPort
  private readonly handles = new Map<string, TraceHandle>()

  constructor(port: TelemetryPort) {
    this.port = port
  }

  get adapterName(): string {
    return this.port.name
  }

  /** 导出的 span 总数（测试断言"真的发出去了"） */
  exportedSpanCount(): number {
    return this.port.exports().reduce((sum, record) => sum + record.spanCount, 0)
  }

  /** 导出尝试次数与失败次数（用于验证"Phoenix 离线不阻塞角色"） */
  exportSummary(): { attempts: number; failures: number } {
    const records = this.port.exports()
    return {
      attempts: records.length,
      failures: records.filter((r) => !r.ok).length,
    }
  }

  begin(trace: CharacterRunTrace): void {
    try {
      this.handles.set(String(trace.traceId), this.port.startTrace(trace))
    } catch (error) {
      logger.debug(`[telemetry] startTrace 失败（已忽略）: ${String(error)}`)
    }
  }

  step(traceId: TraceId, step: TraceStep): void {
    try {
      const handle = this.handles.get(String(traceId))
      this.port.addSpan(String(traceId), step, handle?.spanId)
    } catch (error) {
      logger.debug(`[telemetry] addSpan 失败（已忽略）: ${String(error)}`)
    }
  }

  async end(trace: CharacterRunTrace): Promise<void> {
    const handle = this.handles.get(String(trace.traceId))
    this.handles.delete(String(trace.traceId))
    try {
      if (trace.status === 'failed' && trace.error) handle?.error(trace.error)
      await this.port.finish(trace)
    } catch (error) {
      logger.debug(`[telemetry] finish 失败（已忽略）: ${String(error)}`)
    }
  }

  async shutdown(): Promise<void> {
    this.handles.clear()
    try {
      await this.port.shutdown()
    } catch (error) {
      logger.debug(`[telemetry] shutdown 失败（已忽略）: ${String(error)}`)
    }
  }
}
