/**
 * QQ 主动投递的**登记表**（post-Lv2 / ADR-110 `D07`/`D08`/`D06`）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 一个**很薄**的层：把"外壳报回来的投递结局"翻译成通知实例的状态迁移，
 * 并挡住四类**不该被受理**的回执。它**不**自己存状态 ——
 * 权威在 `notification_occurrences`（`advanceOccurrence` 是唯一写入口）。
 *
 * ```text
 * · deliveryId  ==  occurrenceKey（同一个东西的两个名字）
 *   稳定性 / 确定性由 `reminderOccurrenceKey` / `careOccurrenceKey` 保证（`D07`）
 * · 结局三态 ⇒ 实例状态同名三态（api_accepted / failed_confirmed / delivery_unknown）
 * · `connection generation`：多外壳在线时**只有当前代次**有权投递；
 *   旧代次的回执**不得**覆盖新状态（`D06`）
 * ```
 *
 * ============================================================================
 *  它挡的四类回执（每条具名）
 * ============================================================================
 * ```text
 * ① 认不出来的 deliveryId        ⇒ qq_delivery_unknown_id
 * ② 同一个结局又报一次            ⇒ qq_delivery_duplicate_receipt（**幂等，不是失败**）
 * ③ 已定案又换一个结局            ⇒ qq_delivery_already_settled
 *    ⚠️ 含 delivery_unknown → api_accepted：结果不明**永远**不明（迁移表逐字如此）
 * ④ 来自旧代次连接                ⇒ qq_delivery_stale_generation
 * ```
 * ⚠️ 四条的 `accepted:false` **都不是**"投递失败"：它们是"这条回执没有改变任何东西"。
 *    投递失败是 `failed_confirmed`，那是**一条被受理的回执**。
 *
 * ⚠️ 本模块在 `kernel/app/` 下（可以依赖基础设施），但它**只**吃一个端口，
 *    因此判据层能拿一个内存实现把四类回执逐个跑出来。
 */
import type { NotificationOccurrenceState } from '../contracts/notification.ts'
import { isTerminalOccurrenceState } from '../contracts/notification.ts'

/**
 * 外壳能报的**投递结局**（与 `turn-bridge.ts` 的闭集**同源**）。
 *
 * ⚠️ 这里刻意**重新声明**而不是 import 桥的类型：`kernel/app/bridge` 是桥自己的模块，
 *    而这层是投递登记的领域概念。两者的成员必须一致 —— 有一条判据盯着这件事
 *    （`postlv2:qq-proactive:verify` §19）。
 */
export type QqDeliveryStatus = 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'

export const QQ_DELIVERY_STATUSES: readonly QqDeliveryStatus[] = [
  'api_accepted',
  'failed_confirmed',
  'delivery_unknown',
]

/** 结局 ⇒ 实例状态：**同名**（一张一一对应的表，不发明第四种状态） */
const STATUS_TO_STATE: Readonly<Record<QqDeliveryStatus, NotificationOccurrenceState>> = Object.freeze({
  api_accepted: 'api_accepted',
  failed_confirmed: 'failed_confirmed',
  delivery_unknown: 'delivery_unknown',
})

export interface QqDeliveryReceiptReading {
  /** 这条回执**有没有真的推进**登记（重复/未知/旧代次 ⇒ `false`，且**不**是失败） */
  readonly accepted: boolean
  /** 具名理由码（`accepted === false` 时必有） */
  readonly code?: string
  /** 推进之后的实例状态（认不出来时 `undefined`） */
  readonly recordedState?: NotificationOccurrenceState
}

/** 这层需要的**唯一**端口（权威在持久层；这里拿一个形状） */
export interface NotificationDeliveryPort {
  /** 读一个实例的当前状态（认不出来 ⇒ `undefined`） */
  readOccurrenceState(occurrenceKey: string): Promise<NotificationOccurrenceState | undefined>
  /** 推进实例状态（**唯一**写入口；它自己会复核迁移表） */
  advanceOccurrence(input: {
    occurrenceKey: string
    to: NotificationOccurrenceState
    platformMessageId?: string
    reasonCode?: string
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }>
}

export interface QqDeliveryRegistryOptions {
  readonly store: NotificationDeliveryPort
  /** 诊断钩子（**不含**正文 —— 这条线上没有正文） */
  readonly onReading?: (reading: {
    event: string
    occurrenceKey: string
    status?: QqDeliveryStatus
    code?: string
    generation?: number
  }) => void
}

/** 一条投递连接的**出站口**（把一行 `DELIVER_QQ_TEXT` 写出去） */
export type QqDeliverySink = (input: { deliveryId: string; text: string }) => {
  written: boolean
  code?: string
}

export interface QqDeliveryRegistryReadings {
  /** 开过几条投递连接（每一条 = 一个代次） */
  readonly connectionsOpened: number
  readonly currentGeneration: number | null
  readonly accepted: number
  readonly refusedUnknownId: number
  readonly refusedDuplicate: number
  readonly refusedSettled: number
  readonly refusedStaleGeneration: number
  readonly dispatched: number
  /** 最后一次**成功写出**的投递 id（**不含正文**） */
  readonly lastDeliveryId: string | null
  readonly lastCode: string | null
}

export class QqDeliveryRegistry {
  private readonly store: NotificationDeliveryPort
  private readonly onReading: QqDeliveryRegistryOptions['onReading']
  /**
   * 每条连接的**出站口**（按代次存）。
   *
   * ⚠️ 断开时删掉它自己那一格 —— 旧连接的口**不会**被新连接复用，
   *    也不会在断开后还留着（留着就等于"往一条已死的 socket 写"）。
   */
  private readonly sinks = new Map<number, QqDeliverySink>()
  private generation: number | null = null
  private connections = 0
  private readonly counters = {
    accepted: 0,
    refusedUnknownId: 0,
    refusedDuplicate: 0,
    refusedSettled: 0,
    refusedStaleGeneration: 0,
    dispatched: 0,
    lastDeliveryId: null as string | null,
    lastCode: null as string | null,
  }

  constructor(options: QqDeliveryRegistryOptions) {
    this.store = options.store
    this.onReading = options.onReading
  }

  // -------------------------------------------------------------------------
  // 连接代次（`D06`：多外壳在线时只有当前代次有权投递）
  // -------------------------------------------------------------------------

  /**
   * 开一条新的投递连接，返回它的**代次**。
   *
   * ⚠️ 单调递增，**不回收**：代次是一个只增不减的水位，
   *    这样"旧连接的回执"永远能用一个整数判出来。
   *
   * ⚠️ `deliver` 是**这条连接自己的**出站口（写一行 `DELIVER_QQ_TEXT` 给它）。
   *    把"哪条连接能发"与"往哪里发"绑在**同一个代次**上 ⇒
   *    适配器不需要知道"当前是哪条连接"，它只问登记表。
   *    不传 = 这条连接不发东西（例如皮套入口）。
   */
  openConnection(sink?: QqDeliverySink): number {
    this.connections += 1
    this.generation = this.connections
    if (sink !== undefined) this.sinks.set(this.generation, sink)
    return this.generation
  }

  /**
   * 把一行正文交给**当前**那一条投递连接（`D06`）。
   *
   * ⚠️ 它是能力适配器的**唯一**出站口：适配器不问"当前是哪条连接"，
   *    只问登记表 —— 于是"只有当前代次能投递"在结构上成立（不是靠调用方自觉）。
   */
  deliver(input: { deliveryId: string; text: string }): { written: boolean; code?: string } {
    if (this.generation === null) return { written: false, code: 'qq_delivery_no_active_connection' }
    const sink = this.sinks.get(this.generation)
    if (sink === undefined) return { written: false, code: 'qq_delivery_no_active_connection' }
    const reading = sink(input)
    if (reading.written) this.counters.lastDeliveryId = input.deliveryId
    else this.counters.lastCode = reading.code ?? 'qq_delivery_not_written'
    return reading
  }

  /** 当前有权投递的代次（**从未开过连接** ⇒ `null`） */
  currentGeneration(): number | null {
    return this.generation
  }

  /** 一条连接断了：**只有它仍是当前代次时**才把水位清掉（旧连接断开不该清掉新连接） */
  closeConnection(generation: number): boolean {
    if (this.generation !== generation) return false
    this.generation = null
    this.sinks.delete(generation)
    return true
  }

  /**
   * 投递**之前**的闸：这一次调用有权投递吗。
   *
   * ⚠️ 与"回执是否受理"是**两条不同的判据**：这里是"根本不该发"（没有当前连接 / 不是当前代次），
   *    那里是"发过了，回执晚了"。
   */
  assertDeliverable(generation: number | null): { ok: boolean; code?: string } {
    if (this.generation === null) return { ok: false, code: 'qq_delivery_no_active_connection' }
    if (generation !== this.generation) return { ok: false, code: 'qq_delivery_not_current_connection' }
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // 投递登记
  // -------------------------------------------------------------------------

  /**
   * 把实例推进到 `dispatching`（"已经交给外壳了"）。
   *
   * ⚠️ 这一步**只**说明"交给外壳了"，**不**说明任何平台事实（`D08`）。
   *    权威状态要等回执 —— 在那之前它的口吻必须是"已尝试"。
   */
  async beginDispatch(input: {
    occurrenceKey: string
    generation: number | null
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }> {
    const gate = this.assertDeliverable(input.generation)
    if (!gate.ok) {
      this.counters.lastCode = gate.code ?? null
      this.onReading?.({ event: 'qq_dispatch_refused', occurrenceKey: input.occurrenceKey, code: gate.code })
      return { ok: false, code: gate.code }
    }
    const advanced = await this.store.advanceOccurrence({
      occurrenceKey: input.occurrenceKey,
      to: 'dispatching',
    })
    if (!advanced.ok) {
      this.counters.lastCode = advanced.code ?? null
      this.onReading?.({ event: 'qq_dispatch_refused', occurrenceKey: input.occurrenceKey, code: advanced.code })
      return advanced
    }
    this.counters.dispatched += 1
    this.counters.lastCode = null
    return advanced
  }

  /**
   * 受理一条**投递回执**（= `TurnBridgeHost.reportQqDelivery` 的实现体）。
   *
   * ⚠️ `generation` 由**装配层按"收到这一行的连接"**给出 ——
   *    协议里刻意**没有**代次字段（外壳不该知道也不该声称自己是第几条连接）。
   *    不传代次 = 不检查代次（门内的单连接夹具就是这种情形）。
   */
  async report(input: {
    deliveryId: string
    status: QqDeliveryStatus
    messageId?: string
    attempt?: number
    reason?: string
    generation?: number
  }): Promise<QqDeliveryReceiptReading> {
    const occurrenceKey = String(input.deliveryId ?? '').trim()

    if (input.generation !== undefined && input.generation !== this.generation) {
      this.counters.refusedStaleGeneration += 1
      this.counters.lastCode = 'qq_delivery_stale_generation'
      this.onReading?.({
        event: 'qq_receipt_refused',
        occurrenceKey,
        status: input.status,
        code: 'qq_delivery_stale_generation',
        generation: input.generation,
      })
      return { accepted: false, code: 'qq_delivery_stale_generation' }
    }

    const state = await this.store.readOccurrenceState(occurrenceKey)
    if (state === undefined) {
      this.counters.refusedUnknownId += 1
      this.counters.lastCode = 'qq_delivery_unknown_id'
      this.onReading?.({ event: 'qq_receipt_refused', occurrenceKey, status: input.status, code: 'qq_delivery_unknown_id' })
      return { accepted: false, code: 'qq_delivery_unknown_id' }
    }

    const target = STATUS_TO_STATE[input.status]
    /* ② 同一个结局又报一次 ⇒ 幂等（**不**是失败） */
    if (state === target) {
      this.counters.refusedDuplicate += 1
      this.counters.lastCode = 'qq_delivery_duplicate_receipt'
      this.onReading?.({ event: 'qq_receipt_duplicate', occurrenceKey, status: input.status })
      return { accepted: false, code: 'qq_delivery_duplicate_receipt', recordedState: state }
    }
    /* ③ 已定案的实例不许被改成另一个结局（含 delivery_unknown → api_accepted） */
    if (isTerminalOccurrenceState(state)) {
      this.counters.refusedSettled += 1
      this.counters.lastCode = 'qq_delivery_already_settled'
      this.onReading?.({
        event: 'qq_receipt_refused',
        occurrenceKey,
        status: input.status,
        code: 'qq_delivery_already_settled',
      })
      return { accepted: false, code: 'qq_delivery_already_settled', recordedState: state }
    }

    /*
     * ⚠️ `platformMessageId` **只**在 `api_accepted` 时给；其它结局给了也不传
     *    （表级 CHECK 与 `advanceOccurrence` 都会挡"接受却无回执 id"，这里不制造噪音）。
     */
    const advanced = await this.store.advanceOccurrence({
      occurrenceKey,
      to: target,
      ...(input.status === 'api_accepted' && input.messageId !== undefined
        ? { platformMessageId: input.messageId }
        : {}),
      ...(input.reason === undefined ? {} : { reasonCode: input.reason }),
    })
    if (!advanced.ok) {
      this.counters.lastCode = advanced.code ?? null
      this.onReading?.({ event: 'qq_receipt_refused', occurrenceKey, status: input.status, code: advanced.code })
      return { accepted: false, code: advanced.code, recordedState: advanced.state }
    }
    this.counters.accepted += 1
    this.counters.lastCode = null
    this.onReading?.({ event: 'qq_receipt_accepted', occurrenceKey, status: input.status })
    return { accepted: true, recordedState: advanced.state ?? target }
  }

  readings(): QqDeliveryRegistryReadings {
    return {
      connectionsOpened: this.connections,
      currentGeneration: this.generation,
      accepted: this.counters.accepted,
      refusedUnknownId: this.counters.refusedUnknownId,
      refusedDuplicate: this.counters.refusedDuplicate,
      refusedSettled: this.counters.refusedSettled,
      refusedStaleGeneration: this.counters.refusedStaleGeneration,
      dispatched: this.counters.dispatched,
      lastDeliveryId: this.counters.lastDeliveryId,
      lastCode: this.counters.lastCode,
    }
  }

  /**
   * 定案为"**确定没发出**"（网关拒了）。
   *
   * ⚠️ 它**只**服务于一条路径：进了 `dispatching` 之后本地确定失败。
   *    它**不许**被用来把"结果不明"改成任何东西 —— 那条路由迁移表挡着
   *    （`delivery_unknown` 是终态）。
   */
  async settleConfirmedFailure(input: {
    occurrenceKey: string
    reasonCode: string
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }> {
    const advanced = await this.store.advanceOccurrence({
      occurrenceKey: input.occurrenceKey,
      to: 'failed_confirmed',
      reasonCode: input.reasonCode,
    })
    if (advanced.ok) this.counters.lastCode = null
    else this.counters.lastCode = advanced.code ?? null
    return advanced
  }
}
