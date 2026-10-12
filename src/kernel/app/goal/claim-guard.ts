/**
 * 目标 / 承诺的**回复真相守卫**（Lv2 `LV2-D11` 的 ② 项；用户 2026-10-02 批准）。
 *
 * ============================================================================
 *  它解决什么（有实测支撑，不是推测）
 * ============================================================================
 * Lv2 第三代的 4 条严重错误里 **3 条是 `false_execution_claim`**：
 * ```text
 *   C07-01（两轮）  用户：「好，就这么说定了。」→ 她：「嗯。说定了。」   程序里**承诺行 = 0**
 *   C08-06（一轮）  用户：「我们再约一次：…」  → 她：「嗯。记下了。」   程序里**没有新的一条**
 * ```
 * ⇒ 她说"记下了 / 说定了"，而库里什么都没有。
 * 记忆侧有 `applyResponseTruthPolicy`、动作侧有 `applyActionClaimGuard`、
 * 外部证据侧有 `applyExternalEvidenceReplyPolicy` —— **目标/承诺这一格此前没有守卫**。
 *
 * ============================================================================
 *  设计口径（为什么是"后置 + 窄词表 + 两层键"）
 * ============================================================================
 * ① **后置**：它替换的是**已经生成**的回复（与动作守卫同一位置、同一纪律：
 *    在写账本与写记忆**之前**替换 ⇒ 用户看到的、账本记的、实际发生的三者一致）。
 *    ⇒ **不碰 prompt 的逐字节基线**（`evals/fixtures/m3.5/prompt-baseline.txt` 安全）。
 * ② **窄词表 + 与其它守卫不共用**（`scripts/kernel-tests-action.ts` §5.17 立的规矩）：
 *    承诺专属标记只收**只能指承诺**的说法（说定了 / 就这么定 / 定下了 / 一言为定）；
 *    记录类标记在本轮没有写入时拦截；只创建目标时说明目标已记、约定未成立。
 *    记忆写入成功的合法确认仍然放行。
 * ③ **键是"程序事实"**：`commitmentWritten` / `anythingWritten` 由调用方从**本轮的目标回合结果**
 *    与记忆写入结论里取（两者都在**生成回复之前**就已经确定）。
 * ④ **不外推**：它**不**让 `C07` 的正控变绿（"她该不该写下承诺"是理解链的事），
 *    它只保证"**她说的话与程序事实一致**"。
 */

import { scanClaims } from '../../action/claim-scanner.ts'

/**
 * **承诺专属**成功口吻：这些说法只能指"一条约定被记下来了"。
 *
 * ⚠️ 刻意**不含** `记住了` / `记下了`（它们可以指记忆写入 ⇒ 误伤记忆侧）——
 *    后者见 `RECORD_CLAIM_MARKERS`；记忆确认放行，只有目标记录时说明类型。
 */
export const COMMITMENT_CLAIM_MARKERS: readonly string[] = [
  '说定了',
  '就这么定',
  '就这么说定',
  '定下了',
  '一言为定',
  '算数了',
  '答应你了',
  '这条约定算',
]

/**
 * **记录类**成功口吻：没有写入时拦截；只创建目标时须说明记录类型。
 */
export const RECORD_CLAIM_MARKERS: readonly string[] = ['记住了', '记下了', '记上了', '记录下来了', '写着呢', '记这条']

export interface CommitmentClaimGuardInput {
  /** 本轮**真的**写下了一条承诺（`COMMITMENT_ACCEPTED` 之类） */
  readonly commitmentWritten: boolean
  /** 本轮**真的**写了任何东西（记忆 / 目标 / 承诺 至少一项） */
  readonly anythingWritten: boolean
  /** 本轮创建了目标；没有 COMMITMENT_ACCEPTED 时，泛称“记下了”须说明记录类型。 */
  readonly goalCreated?: boolean
  /** 模型生成的回复 */
  readonly replyText: string
}

export interface CommitmentClaimGuardOutcome {
  readonly replyText: string
  readonly corrected: boolean
  /** `corrected === true` 时非空 */
  readonly markers: readonly string[]
  /** 这一轮是否**允许**承诺成功口吻（真写了才允许） */
  readonly allowedSuccess: boolean
}

/** 校验通过的事件类型不代表已经提交；提交失败时 trace 仍保留那些类型。 */
export function commitmentWriteFacts(reality?: {
  readonly acceptedEventTypes: readonly string[]
  readonly eventsCommitted: number
}): { commitmentWritten: boolean; goalCreated: boolean } {
  const written = (reality?.eventsCommitted ?? 0) > 0
  return {
    commitmentWritten: written && (reality?.acceptedEventTypes.includes('COMMITMENT_ACCEPTED') ?? false),
    goalCreated: written && (reality?.acceptedEventTypes.includes('GOAL_CREATED') ?? false),
  }
}

/** 回复里是否出现了**无据**的承诺口吻（真写了就不算"无据"）。 */
export function replyClaimsCommitmentSuccess(input: {
  readonly commitmentWritten: boolean
  readonly anythingWritten: boolean
  readonly goalCreated?: boolean
  readonly replyText: string
}): { claims: boolean; markers: readonly string[] } {
  if (input.commitmentWritten) return { claims: false, markers: [] }
  const commitmentOnly = scanClaims(input.replyText, COMMITMENT_CLAIM_MARKERS)
  if (commitmentOnly.claims) return { claims: true, markers: commitmentOnly.markers }
  /* 记忆确认照旧放行；目标创建不能替代新约定的接受。 */
  if (input.anythingWritten && !input.goalCreated) return { claims: false, markers: [] }
  return scanClaims(input.replyText, RECORD_CLAIM_MARKERS)
}

/**
 * 如实的替换句。
 *
 * 口径：**不假装**、**不承诺**、**给出下一步**；而且必须**语气中性**——
 * 记「记录类」标记（`记下了` / `记上了`）时，没写下的可能是**约定**，也可能是一句**记忆**
 * （记忆守卫的词表只收 `记住了` / `忘掉了`，`记下了` 会从它那里漏过来）。
 * ⇒ 所以没有写入时的替换句**不**说"约定"两个字：说"约定"会把一句记忆请求答成约定，
 *    用户看到的是**牛头不对马嘴的如实**（如实但答错题）。
 * 刻意**不**复述内容（`L-M10.1-17` 的教训：复述会把"没写下来"变成"她记住了内容"）。
 */
export function truthfulCommitmentSentence(goalCreated = false): string {
  if (goalCreated) return '目标记录已经留下，但还没有写成新的约定。'
  return '这轮没有确认新的记录写入成功；不能据此判断之前没有记录。'
}

/**
 * 应用目标/承诺守卫。
 *
 * 纯函数：同输入必同输出（与动作守卫同一条纪律）。
 */
export function applyCommitmentClaimGuard(input: CommitmentClaimGuardInput): CommitmentClaimGuardOutcome {
  if (input.commitmentWritten) {
    return { replyText: input.replyText, corrected: false, markers: [], allowedSuccess: true }
  }
  const claim = replyClaimsCommitmentSuccess({
    commitmentWritten: false,
    anythingWritten: input.anythingWritten,
    ...(input.goalCreated === undefined ? {} : { goalCreated: input.goalCreated }),
    replyText: input.replyText,
  })
  if (!claim.claims) {
    return { replyText: input.replyText, corrected: false, markers: [], allowedSuccess: false }
  }
  const proposalClauses = input.goalCreated === true
    ? input.replyText.split(/(?<=[，,。！？；\n])/u).filter(text =>
        !replyClaimsCommitmentSuccess({ ...input, replyText: text }).claims).join('').trim()
    : ''
  return {
    replyText: [proposalClauses, truthfulCommitmentSentence(input.goalCreated)].filter(Boolean).join('\n'),
    corrected: true,
    markers: claim.markers,
    allowedSuccess: false,
  }
}

/** 已核对的结清结果不能被回复改成再次索要确认。仅程序确认的范围启用。 */
export function applySettlementConfirmationGuard(replyText: string, settledCount: number): {
  replyText: string; corrected: boolean
} {
  if (settledCount <= 0) return { replyText, corrected: false }
  const clauses = replyText.split(/(?<=[。！？；\n])/u)
  const kept = clauses.filter(clause =>
    /(?:不用|无需|不必|不需要).{0,8}(?:确认|追问|问哪|说清楚|挂着)/u.test(clause) ||
    !/哪[一两三几]条|结掉还是|结清还是|继续挂着[吗？?]|只改了数量|再确认一下|需要.{0,5}确认|请.{0,5}确认|等你.{0,5}确认|再说[清一]|说清楚|没结上|落不了|你说的是这个吧/u.test(clause))
  if (kept.length === clauses.length) return { replyText, corrected: false }
  return { replyText: [kept.join('').trim(), '对应的约定已经结清，不需要再确认。'].filter(Boolean).join('\n'), corrected: true }
}
