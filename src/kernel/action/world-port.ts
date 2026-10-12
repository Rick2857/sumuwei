/**
 * WorldPort —— **只留接口，不实现**（M4.5 §23 / §24）。
 *
 * ============================================================================
 *  Memory ≠ Belief ≠ World State
 * ============================================================================
 * ```text
 * Memory     长期存储的事实 / 经历
 * Belief     角色当前认为是真的东西（M5）
 * WorldState 外部世界当前可观察状态（M5+）
 * ```
 *
 * 三者分开的**实际理由**是一条很容易被违反的推理：
 *
 * ```text
 * 记忆里写着 X  →  外部世界现在仍然是 X        ← 错
 * ```
 *
 * 记忆的语义是"我们记录过 X"，不是"世界现在就是 X"。
 * 一旦允许从记忆直接推出世界状态，M4 建立的证据链就会被绕开。
 *
 * ---------------------------------------------------------------------------
 *  M4.5 只做"插座"，不买"电器"
 * ---------------------------------------------------------------------------
 * 本文件只有类型与注释：**没有实现、没有调用点**。
 * 计划书 §24 明确 M4.5 不实现复杂预测 / 物理模拟 / 社会模拟 / 长期 planning。
 *
 * ⚠️ 它刻意不是"空实现"（不是返回 `{}` 的函数）：
 *    一个能被调用的空实现会被当成"世界模型已经有了"。
 *    类型 + 注释才是"位置已预留"的诚实表达 ——
 *    与 M3.5 那句"不是 World，而是 World Boundary"是同一条纪律。
 */

import type { Timestamp } from '../contracts/ids.ts'

/** 对世界的一次观测（M5 才会真的产生它） */
export interface WorldObservation {
  /** 观测来源（如 `http` / `filesystem` / `sensor`） */
  source: string
  /** 观测到的对象（自由形状；由具体观测者定义） */
  subject: string
  /** 观测到的属性 */
  attribute: string
  value: unknown
  observedAt: Timestamp
}

/**
 * 对世界的一次预测（M5+）。
 *
 * ⚠️ 预测**不是事实**。它进不了 ActionResult，也不进 ConversationEvent ——
 * 它的归宿是角色内部的 Belief，而 Belief 与 WorldState 必须能分别存在
 * （M3.5 的 FC-07 / ADR-017）。
 */
export interface WorldPrediction {
  subject: string
  attribute: string
  expected: unknown
  /** 这个预测凭什么成立（证据引用） */
  basedOn: string[]
  confidence: number
  predictedFor?: Timestamp
}

/** 模拟结果（M5+；M4.5 不产生任何一条） */
export interface SimulationResult {
  scenario: string
  horizon: Timestamp
  outcomes: readonly { probability: number; description: string }[]
}

/**
 * 未来世界接口的形状（**尚未实现**）。
 *
 * 存在的意义是让"世界观测 → Belief 更新 → 预测 → 行动"这条链
 * 有一个可接的位置，而不是让 M4.5 去实现它。
 */
export interface WorldPort {
  observe?(query: { subject: string; attribute?: string }): Promise<WorldObservation[]>
  predict?(input: { subject: string; attribute: string }): Promise<WorldPrediction | undefined>
}
