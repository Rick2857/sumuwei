/**
 * ClaimScanner —— "**未被否定的**成功口吻"这句话的唯一实现。
 *
 * ============================================================================
 *  它从 M4.1 的 `response-truth.ts` 抽出来，行为一个字节都不变
 * ============================================================================
 * M4.1 的守卫用一条规则判定"这句话是不是在宣称成功"：
 *
 * ```text
 * 标记出现位置往前 4 个字符里若有否定词，就认为这是如实的否定表述
 * ```
 *
 * M4.5 增加了**第二套**标记（动作词表，见 `claim-guard.ts`），
 * 但判定方式必须完全一样 —— 否则同一个词在记忆守卫与动作守卫下
 * 会有两种结论，而那正是"两份实现慢慢长歪"的起点。
 *
 * ⚠️ 因此这里刻意只做一件事：给定词表 + 给定文本，回答"命中了哪些"。
 *    4 个字符的窗口是实测选的（要能覆盖"我**没有**记住" / "我**没能**记住"，
 *    又不至于把上一句的否定吸进来），不要随手改。
 */

/** 否定词（与 M4.1 完全一致） */
export const CLAIM_NEGATIONS: readonly string[] = ['不', '没', '未', '无', '别']

export interface ClaimScanResult {
  claims: boolean
  markers: string[]
}

/**
 * 扫描"未被否定的成功口吻"。
 *
 * 纯函数：同输入必同输出，不读时间、不读环境、不写任何东西 ——
 * 因此它的判据可以用离线单测穷举。
 */
export function scanClaims(
  text: string,
  markers: readonly string[],
  options: { negationWindow?: number } = {}
): ClaimScanResult {
  const window = options.negationWindow ?? 4
  const hits: string[] = []
  for (const marker of markers) {
    let from = 0
    for (;;) {
      const at = text.indexOf(marker, from)
      if (at === -1) break
      const before = text.slice(Math.max(0, at - window), at)
      const negated = CLAIM_NEGATIONS.some((n) => before.includes(n))
      if (!negated) hits.push(marker)
      from = at + marker.length
    }
  }
  return { claims: hits.length > 0, markers: hits }
}
