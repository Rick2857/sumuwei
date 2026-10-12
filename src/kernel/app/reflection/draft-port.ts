/**
 * M11 WP3/WP10 —— **反思候选的模型端口**（ADR-085 `D29` · `D30` · 契约 §2）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 一个**恰好一次**的调用形状：程序给出**有界窗口**与**合法 handle 集合**，
 * 模型只回一个**原始对象**；结构校验（`parseReflectionDraft`）在**内核**，
 * 不在适配器里 —— 与 `GoalUnderstandingProvider` 同一条纪律。
 *
 * ============================================================================
 *  三条硬边界（都是判据）
 * ============================================================================
 * ① **有界**：`window` 与 `handles` 都来自 `buildReflectionInput()`（≤50 输入 / ≤6000 token），
 *    适配器**不得**自己去读库、不得扩大窗口。
 * ② **只回原始对象**：适配器**不**做结构校验、不重试、不降级重问、不挑候选。
 * ③ **失败要分对桶**：网络 / HTTP / 没有 key ⇒ **抛**（内核映射成 `transport`）；
 *    模型给了东西但不是 JSON ⇒ **把原文交回**（内核判 `invalid`）。
 *    把"不是 JSON"抛成 transport 会说"这次调用失败了"，而它其实**成功了**。
 *
 * ⚠️ 纯类型 + 纯函数：不 import 框架 / SQL / `node:*`。
 */

import type { ReflectionHandle } from '../../contracts/reflection.ts'
import type { ReflectionWindowEntry } from '../../contracts/reflection-input.ts'

export interface ReflectionDraftCall {
  /** 字符 id（程序侧） */
  readonly characterId: string
  /**
   * **有界窗口**（`D30`：≤50 输入）。
   *
   * 只给"她与用户之间发生了什么"的**最小读数**：句柄 id / 角色 / 有界文本 / 序号。
   * 工具输出与程序内部细节**不进**窗口（它们不是她的经历）。
   */
  readonly window: readonly ReflectionWindowEntry[]
  /** 程序解析出的**合法 handle 集合**（模型只能从这里引用；不许编造 id） */
  readonly handles: readonly ReflectionHandle[]
  /** 已有反例的 handle（程序侧已判定"这一条与候选解释相反"） */
  readonly counterHandles: readonly ReflectionHandle[]
  /** 触发原因码（程序给，不是模型猜） */
  readonly triggerReasonCodes: readonly string[]
  /** Current lineage reading; a shared input window does not imply a shared source conversation. */
  readonly sourceConversationCount?: number
  /** 硬期限（毫秒）—— 与 `D30` 的 20 秒一致 */
  readonly deadlineMs: number
  readonly signal?: AbortSignal
}

export interface ReflectionDraftProvider {
  readonly name: string
  readonly version: string
  readonly promptVersion?: string
  /** **恰好一次**调用；返回**原始**对象（结构校验在内核） */
  call(call: ReflectionDraftCall): Promise<unknown>
}
