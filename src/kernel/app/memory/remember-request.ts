/**
 * ★ A2（2026-10-10）：**这一轮用户是不是在要求她记住 / 改动记忆** —— 冻结的纯函数。
 *
 * ============================================================================
 *  它要修的是什么（真机事故）
 * ============================================================================
 * ```text
 * 2026-10-10 17:22 用户：记得在5:55提醒我去抢课,不要管我有没有回复收到
 * 2026-10-10 17:23 用户：什么意思？
 *                  她的回复（两条都被替换）：收到，记忆请求会在这轮回复后处理；现在还没有完成。
 * ```
 * 根因（行号级）：`.env` 是 `CHARACTER_MEMORY_WRITE_MODE=post_turn_model`，
 * 而那个模式下的端口是**常量**（`post-turn-model-memory.ts:47` 逐字：
 * *No classification or model call before the reply; only an execution-truth fact*）：
 * ```ts
 * handleTurn: async () => ({ kind:'not_written', intent:'remember', reason:'pending_post_turn', … })
 * ```
 * ⇒ **每一轮**都带 `pending_post_turn`；于是 `response-truth.ts` 的替换只看**她自己措辞**
 *   里有没有"记住了 / 我记着" ⇒ 她在**与记忆无关**的语境里随口一说（例如回答"什么意思？"），
 *   **整轮回复就被那句模板顶掉** = "答非所问"。
 *
 * ============================================================================
 *  为什么是"物形判据"而不是模型判断（这是硬约束，不是省事）
 * ============================================================================
 * `post_turn_model` 模式**不允许在回复前调模型**（上面那句逐字注释）
 * ⇒ 只能便宜地在**用户原话**上判。这是一个**取舍**，如实记：
 *   · **取宽召回**（宁可多认）：漏判的代价是"她谎称已写入而**不被纠正**"——
 *     那是 `INV-M41-03 / INV-CI-03`（回复绑定程序事实）被削弱，**严重**；
 *   · 误判的代价是"多替换一句"，**可接受**。
 * ⇒ 所以本函数的词表**刻意宽松**，而且它与替换**是两条同时成立的条件**
 *   （① 用户确实要求记住 ② 她的回复里出现未被否定的成功口吻），加它**不会**削弱那条不变式。
 *
 * ⚠️ 为什么**不** import 既有的问句守卫（`content-extractor.ts:140` /
 *    `fast-signal.ts:311` 各有一份）：那两个模块会把记忆抽取/桥接的依赖整片拖进来，
 *    而本函数要能被**门直接 import**（判据要可被机器量到，先例 `precheckCareOpportunity`）。
 *    这里只做一件最小的事：**纯问句不算"要求记住"**（先例 `L-M97-02` 的问句守卫精神）。
 */

import { isExplicitForgetCommand } from './forget-request.ts'

/** 要求她**记住 / 改动记忆**的词形（宽松召回；命中一个即算） */
const REMEMBER_MARKERS: readonly RegExp[] = [
  /记(?:住|得|下|一下|着)/u, // 记住 / 记得 / 记下 / 记一下 / 记着
  /帮我记/u,
  /别忘|不要忘/u, // 提醒类
  /别再提|别提了/u,
  /删(?:掉|除).{0,6}(?:记忆|这条|那条)/u, // 删除类
  /(?:改成|更正|纠正|纠正为|不是.{1,12}是)/u, // 更正类
  /(?:记忆|长期记住|永久记住)/u, // 直接谈"记忆"
]

/** 纯问句形态（`？` / `吗` 结尾等）：**问句不是"要求记住"** */
function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  return /[?？]\s*$/u.test(trimmed) || /(?:吗|呢|么)\s*[?？]?\s*$/u.test(trimmed)
}

/**
 * 本轮用户原话**是不是在要求她记住 / 改动记忆**。
 *
 * ⚠️ 这是**程序事实**（供 `ReplyGuardChainInput.userAskedToRemember` 用），不是策略本身 ——
 *    策略仍在 `response-truth.ts`（那里写着"策略本身在这里，而不是在装配层"）。
 * ⚠️ `undefined`（调用方不传）与 `false` **语义不同**：前者 = 保持既有行为，后者 = 明确不替换。
 */
export function asksToRemember(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (looksLikeQuestion(trimmed)) return false
  return isExplicitForgetCommand(trimmed) || REMEMBER_MARKERS.some(pattern => pattern.test(trimmed))
}
