/**
 * M6.1 **WP6 序号核验 —— 纯逻辑**（无 IO；被 `m6.1-live-long.ts` 与 `m6.1:test` 共同消费）。
 *
 * ============================================================================
 *  它核验什么（冻结单 F-2 的承载判据）
 * ============================================================================
 * 生产装配是**确定性单会话**（`roomId`/`conversationId` 由 character×user 派生），
 * 没有"新会话切换"这个概念（裁定 F-2：登记为设计差异，不引入 M3 host）。
 * 于是"重启后仍然续接"必须由**可查的程序读数**承载：
 *
 * ```text
 *  每完成一轮 = conversation_events 恰 +2 行（user + assistant）
 *  spawn-per-turn（每轮都是进程重启）之后：
 *    ① latestSequence ≥ conversationEvents 且跨检查点不回退
 *       （⚠️ 修正记录：序号是角色级共享计数器 `character_sequence_counters`，
 *        `next_sequence + 1` 逐次分配、非会话事件路径也消耗序号、代码明写
 *        "这次写入留下了空洞" ⇒ 末号 > 总数是设计内行为，等值不是不变量。
 *        V2 正式读数实证：完成 50 轮 ⇒ 末号 152 / 总数 100，每轮约 3 序号 2 行。
 *        原判据"末号 = 总数"是量具错误，已按 §6.6 如实修正——见冻结单 §11。）
 *    ② 2×完成 ≤ 总数 ≤ 2×完成 + 失败（失败轮至多落了 1 个用户事件）
 *    ③ 跨检查点单调不回退（总数与末号都是；回退 = 重启后重置）
 * ```
 *
 * ⚠️ 放在独立纯模块而不是运行器里：运行器是**import 即执行**的 CLI，
 *    测试文件 import 它会把整轮跑起来（`kernel-tests-m6.1.ts` 只能 import 纯模块）。
 */

export interface SequenceCheckpointReading {
  readonly checkpoint: number
  readonly completedTurns: number
  readonly failedTurns: number
  readonly conversationEvents: number
  readonly latestSequence: number
}

export interface SequenceVerification {
  readonly anomalies: readonly string[]
  readonly ok: boolean
}

/**
 * 解析 `--kernel-status` 的 stdout（只读程序读数；**格式对准 `src/main.ts` 的真实输出**）：
 *
 * ```text
 *   ## 事实账本 conversation_events（6 条）          ← 总数行（中文括号格式）
 *     #   1 [user/message] …                        ← 最近事件行（padStart(4) ⇒ 「#」与数字之间有空格！）
 *     #   6 [assistant/message] …
 * ```
 *
 * ⚠️ 第一版正则 `#(\d+) \[` 在真实输出上**匹配零条**（padStart 的空格），
 *    `latestSequence` 恒为 -1 ⇒ 序号核验空转（"量具看起来没问题却什么都没量到"，
 *    §6.8 的形态）。因此解析必须 `#\s*(\d+)\s+\[`，且**必须**有 L1 负控锁住
 *    "格式漂移 ⇒ 读数缺失 ⇒ 异常"这条链。
 */
export interface KernelStatusParse {
  readonly conversationEvents: number
  readonly latestSequence: number
}

export function parseKernelStatus(raw: string): KernelStatusParse {
  const conversationEvents = Number(/conversation_events（(\d+) 条）/.exec(raw)?.[1] ?? -1)
  let latestSequence = -1
  for (const match of raw.matchAll(/#\s*(\d+)\s+\[/g)) {
    const seq = Number(match[1])
    if (Number.isFinite(seq) && seq > latestSequence) latestSequence = seq
  }
  return { conversationEvents, latestSequence }
}

export function verifySequenceContiguity(readings: readonly SequenceCheckpointReading[]): SequenceVerification {
  const anomalies: string[] = []
  for (const reading of readings) {
    if (reading.conversationEvents < 0) anomalies.push(`检查点 ${String(reading.checkpoint)}：kernel-status 读数缺失`)
    if (reading.conversationEvents >= 0 && reading.latestSequence < 0) {
      /* 总数行在、事件行序号没解析到 ⇒ 大概率格式漂移；**记异常**，不许静默跳过等值检查（空转） */
      anomalies.push(
        `检查点 ${String(reading.checkpoint)}：事件总数 ${String(reading.conversationEvents)} 在，但事件行序号没解析到（格式漂移？）`
      )
    }
    if (
      reading.conversationEvents >= 0 &&
      reading.latestSequence >= 0 &&
      reading.latestSequence < reading.conversationEvents
    ) {
      anomalies.push(
        `检查点 ${String(reading.checkpoint)}：最新序号 ${String(reading.latestSequence)} < 事件总数 ${String(reading.conversationEvents)}（计数器落后于账本 ⇒ 异常）`
      )
    }
    const lower = 2 * reading.completedTurns
    const upper = 2 * reading.completedTurns + reading.failedTurns
    if (reading.conversationEvents >= 0 && (reading.conversationEvents < lower || reading.conversationEvents > upper)) {
      anomalies.push(
        `检查点 ${String(reading.checkpoint)}：事件总数 ${String(reading.conversationEvents)} 不在 [${String(lower)}, ${String(upper)}]（完成 ${String(reading.completedTurns)} · 失败 ${String(reading.failedTurns)}）`
      )
    }
  }
  for (let i = 1; i < readings.length; i += 1) {
    const prev = readings[i - 1]!
    const curr = readings[i]!
    if (curr.conversationEvents >= 0 && prev.conversationEvents >= 0 && curr.conversationEvents <= prev.conversationEvents) {
      anomalies.push(
        `检查点 ${String(prev.checkpoint)}→${String(curr.checkpoint)}：事件总数 ${String(prev.conversationEvents)} → ${String(curr.conversationEvents)} 非递增（重启后重置）`
      )
    }
    if (curr.latestSequence >= 0 && prev.latestSequence >= 0 && curr.latestSequence <= prev.latestSequence) {
      anomalies.push(
        `检查点 ${String(prev.checkpoint)}→${String(curr.checkpoint)}：最新序号 ${String(prev.latestSequence)} → ${String(curr.latestSequence)} 非递增（计数器重置）`
      )
    }
  }
  return { anomalies, ok: anomalies.length === 0 }
}
