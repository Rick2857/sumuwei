/**
 * EventTime —— **"什么时候"这件事不能被写死成一个概念**。
 *
 * ============================================================================
 *  M3.5 WP5（计划书第 29–34 / 52 / 71 节）
 * ============================================================================
 * 当前系统只有一个 `createdAt`。它今天够用，因为它一直是同一个东西：
 *
 *     她刚刚说了这句话  →  记下来的时刻  ≈  这句话说出的时刻
 *
 * 但"发生"与"记录"在下面这些情况下**必然分家**，而且**在未来某个时刻一定会发生**：
 *
 * ```text
 * 场景一：导入一段旧对话
 *     occurredAt = 2019-03-02 20:14    （当时说的）
 *     recordedAt = 2026-09-16 10:02    （今天记进来的）
 *
 * 场景二：她说"我等了你三天"
 *     occurredAt = 故事里的三天前
 *     recordedAt = 现实里的现在
 *
 * 场景三（更远）：存在模拟时钟
 *     logicalTime = "第 12 天清晨"
 * ```
 *
 * ---------------------------------------------------------------------------
 *  为什么现在就要留，而不是等 Lv3
 * ---------------------------------------------------------------------------
 * 计划书第 33 节说得很直接：这些字段会进 `Memory` / `DomainEvent` /
 * `ConversationEvent`，而**这些表是 append-only 的**。
 *
 * 等到真的需要区分"发生时间 / 记录时间 / 模拟时间"时，库里已经躺着大量
 * 只有一个 `timestamp` 的行，而那些行**无法回溯判断**它们当初是哪种时间。
 * 迁移只能猜，猜错的代价是永久性的语义污染。
 *
 * 现在加一个 nullable 列的成本是**零**（旧行保持 NULL，读取时是 `undefined`）。
 * 因此这是一个"便宜的现在"换"昂贵的未来"的决定。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ M3.5 不建模拟时钟（计划书第 32 节）
 * ---------------------------------------------------------------------------
 * `logicalTime` 的**位置**留好了，但 `assertEventTime` 会**拒绝**任何非
 * `undefined` 的值（错误码 `simulation_time_not_supported`）。
 *
 * 这不是自相矛盾，而是刻意的：
 *   · 类型里有位置   → 未来实现时不需要改 schema、不需要改任何调用签名
 *   · 运行期失败关闭 → 今天不可能出现"半个模拟时钟"（有人写了 logicalTime
 *                      但没有任何东西按它排序），那种半成品比没有更危险
 */

import { KernelError, type Timestamp } from './ids.ts'

/**
 * M3.5 是否允许 `logicalTime` 取非空值。
 *
 * 常量而不是散落的 `if`：未来启用模拟时间时，**改这一处**，
 * 而 TC-T06 / m3.5:verify 会立刻告诉你哪些地方开始需要处理它。
 */
export const M3_5_ALLOWS_LOGICAL_TIME = false

/**
 * 统一的"事件时间"形状（计划书第 34 节）。
 *
 * 与既有字段的映射（**刻意不 rename**，计划书第 83 节禁止大改 schema）：
 *
 *     EventTime.recordedAt  ≡  既有的 createdAt  ≡  数据库列 created_at
 *
 * 也就是说 `recordedAt` 只存在于**契约命名**里；数据库列名一个字都没动，
 * 因此所有既有 SQL、既有行、既有脚本继续有效。
 */
export interface EventTime {
  /** **必填**：系统什么时候记录到这件事 */
  recordedAt: Timestamp
  /** 可选：这件事什么时候发生。当前对话里 ≈ recordedAt（计划书第 31 节） */
  occurredAt?: Timestamp
  /** 可选：模拟时间。M3.5 必须为 undefined（见 `M3_5_ALLOWS_LOGICAL_TIME`） */
  logicalTime?: string
}

/** 构造（顺便校验；校验不通过就抛，不返回"半个时间"） */
export function eventTimeOf(
  recordedAt: Timestamp,
  occurredAt?: Timestamp,
  logicalTime?: string
): EventTime {
  const time: EventTime = { recordedAt }
  if (occurredAt !== undefined) time.occurredAt = occurredAt
  if (logicalTime !== undefined) time.logicalTime = logicalTime
  assertEventTime(time)
  return time
}

/**
 * 校验时间三元组。**唯一的校验处**。
 *
 * 三条规则：
 *   1. `recordedAt` 必须存在且有限
 *   2. `occurredAt` 若存在必须有限（允许早于、晚于或等于 recordedAt：
 *      故事时间本来就可以是任何时刻，M3.5 不做"不许早于"这种业务判断 ——
 *      那是导入策略的事，不是时间契约的事）
 *   3. `logicalTime` 若存在 → **拒绝**（M3.5 不建模拟时钟）
 */
export function assertEventTime(time: EventTime): void {
  if (!isFiniteTimestamp(time.recordedAt)) {
    throw new KernelError(
      'validation_error',
      'bad_recorded_at',
      `recordedAt 必须是有限时间戳，收到 ${String(time.recordedAt)}。` +
        'NaN/Infinity 会静默地把事件顺序弄坏，而顺序是所有重放与幂等的前提'
    )
  }
  if (time.occurredAt !== undefined && !isFiniteTimestamp(time.occurredAt)) {
    throw new KernelError(
      'validation_error',
      'bad_occurred_at',
      `occurredAt 必须是有限时间戳，收到 ${String(time.occurredAt)}`
    )
  }
  if (time.logicalTime !== undefined && !M3_5_ALLOWS_LOGICAL_TIME) {
    throw new KernelError(
      'validation_error',
      'simulation_time_not_supported',
      'M3.5 不建模拟时钟：logicalTime 的位置已留好，但当前不允许写入非空值。' +
        '只有在真正有"按模拟时间排序"的实现时才可以打开（M3_5_ALLOWS_LOGICAL_TIME）',
      { logicalTime: time.logicalTime }
    )
  }
}

/**
 * 由"只有 createdAt"的既有形状构造 `EventTime`。
 *
 * 存在的意义：让"把旧事件读成 EventTime"这件事**只有一种解释**
 * —— `recordedAt = createdAt`，`occurredAt` 未知（undefined，而不是等于 createdAt）。
 *
 * ⚠️ 刻意**不**把 `occurredAt` 默认为 `createdAt`：
 * "不知道它什么时候发生"与"它就是此刻发生的"是两件不同的事，
 * 用后者冒充前者会让未来的导入逻辑无法分辨哪些行需要补时间。
 * 需要"当前聊天里二者相等"这个语义的地方，由调用方显式传 `occurredAt`。
 */
export function eventTimeFromRecorded(recordedAt: Timestamp, occurredAt?: Timestamp): EventTime {
  return eventTimeOf(recordedAt, occurredAt)
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
