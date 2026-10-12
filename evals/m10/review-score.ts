/**
 * M10（`U-11` 方式甲的执行件）—— **人审计分**（纯函数）。
 *
 * ============================================================================
 *  它要解决的**唯一**问题
 * ============================================================================
 * ```text
 * "用户说已审、无异议"  ──┐
 *                        ├─ 这两件事在**报告里长得一样**，但证据强度差一个量级
 * "用户逐案独立判了 70 张"  ──┘
 * ```
 * 方式甲（逐案独立打分）能给出一个**真实的**一致率：分母 = 卡片数、分子 = 与金标相同的张数。
 * 方式乙（声明式裁定）**不能** —— 它必须字面写 `N/A`（WP10 出口逐字禁止把"无异议"
 * 变成不存在的数字一致率）。
 *
 * ⚠️ 因此本模块的返回类型是**判别联合**：方法乙的读数里**根本没有** `rate` 字段。
 *    "不许编造数字"这条纪律因此是**类型上的**，而不是"我记得别写"。
 *
 * ⚠️ 纯函数：不 import SQL / 框架 / `node:*`。
 */

export interface ReviewAnswer {
  readonly caseId: string
  readonly verdict: string | null
}

export interface GoldEntry {
  readonly caseId: string
  readonly gold: string
}

/** 方式甲：逐案独立打分 —— **有**一致率 */
export interface PerCaseScore {
  readonly method: 'per-case'
  /** 分母：卡片数（**必须与 rate 一起报**） */
  readonly cards: number
  /** 分子：与金标相同的张数 */
  readonly agreed: number
  readonly rate: number
  readonly disagreements: readonly {
    readonly caseId: string
    readonly reviewer: string
    readonly gold: string
  }[]
  /** 没填的卡片（**不得**被算成"同意"） */
  readonly unanswered: readonly string[]
}

/** 方式乙：声明式裁定 —— **没有** `rate` 字段（类型上就没有） */
export interface DeclarativeScore {
  readonly method: 'declarative'
  readonly cards: number
  /** 逐字写 `N/A`：这是**唯一**合法的取值 */
  readonly perCaseRate: 'N/A'
  readonly statement: string
  readonly namedItems: readonly string[]
}

export type ReviewScore = PerCaseScore | DeclarativeScore

/** 计分的**失败关闭**理由（不是异常 —— 是可判定的拒收） */
export type ReviewScoreRefusal =
  | { readonly code: 'no_answers'; readonly detail: string }
  /** 卡片在、但**一张都没答**（"0.0%"会被读成"全判错了"） */
  | { readonly code: 'no_answered'; readonly detail: string }
  | { readonly code: 'unknown_case'; readonly detail: string }
  | { readonly code: 'duplicate_case'; readonly detail: string }

export type ReviewScoreResult =
  | { readonly ok: true; readonly score: ReviewScore }
  | { readonly ok: false; readonly refusal: ReviewScoreRefusal }

/**
 * 方式甲计分。
 *
 * ⚠️ **三条失败关闭**（每一条都对应一种"看起来有数字、其实没有量"的形状）：
 * ```text
 * no_answers      一条答案都没有 ⇒ 拒绝（0/0 与 0% 在输出上长得一样）
 * unknown_case   答案里有金标里不存在的 caseId ⇒ 拒绝（对错账比错更糟）
 * duplicate_case 同一个 caseId 出现两次 ⇒ 拒绝（分母会虚高）
 * ```
 */
export function scorePerCase(
  cards: readonly { readonly caseId: string }[],
  gold: readonly GoldEntry[],
  answers: readonly ReviewAnswer[],
): ReviewScoreResult {
  if (answers.length === 0) {
    return {
      ok: false,
      refusal: { code: 'no_answers', detail: '答案 0 条 ⇒ 分母为 0，不得报一致率' },
    }
  }
  /*
   * ⚠️ **"答了 0 张"也必须拒收**（本轮补的一条；上面那条只挡"答案数组为空"）。
   *
   * 为什么需要它：`--answers <blind-cards.md>` 这条路会为**每张卡**造一条答案，
   * 未填的 `verdict` 是 `null` ⇒ `answers.length` 仍是 70 ⇒ **逃过上面那条拒收**，
   * 于是对一份**一张都没答**的文件报出 `一致率 0.0%`。
   * 那正是本仓库反复踩的那类形状：**"测了个 0"与"什么都没测"在输出上长得一样**
   * （这里更糟：读者会把 `0.0%` 读成"她全判错了"）。
   * ⇒ 一张都没答 ⇒ **拒收**，不报数字。
   */
  if (answers.every((answer) => answer.verdict === null)) {
    return {
      ok: false,
      refusal: {
        code: 'no_answered',
        detail:
          `卡片 ${String(answers.length)} 张，但**一张都没答** ⇒ 不得报一致率` +
          '（"0.0%"会被读成"全判错了"，而实际是"还没判"）',
      },
    }
  }
  const goldByCase = new Map(gold.map((entry) => [entry.caseId, entry.gold]))
  const cardIds = new Set(cards.map((card) => card.caseId))

  const seen = new Set<string>()
  for (const answer of answers) {
    if (!cardIds.has(answer.caseId)) {
      return {
        ok: false,
        refusal: { code: 'unknown_case', detail: `答案里有卡片之外的 caseId：${answer.caseId}` },
      }
    }
    if (seen.has(answer.caseId)) {
      return {
        ok: false,
        refusal: { code: 'duplicate_case', detail: `同一个 caseId 答了两次：${answer.caseId}` },
      }
    }
    seen.add(answer.caseId)
  }

  const answered = answers.filter(
    /* ⚠️ `undefined` 也算**未答**（不只是 `null` / 空串）：调用方给的形状若与约定不符，
       这里必须是"未答"而不是"答了一个 undefined" —— 后者会变成一条假的**分歧**。 */
    (answer) => answer.verdict !== null && answer.verdict !== undefined && answer.verdict !== '',
  )
  const unanswered = cards
    .map((card) => card.caseId)
    .filter((caseId) => !answered.some((answer) => answer.caseId === caseId))

  const disagreements: { caseId: string; reviewer: string; gold: string }[] = []
  for (const answer of answered) {
    const expected = goldByCase.get(answer.caseId)
    if (expected === undefined) continue
    if (answer.verdict !== expected) {
      disagreements.push({
        caseId: answer.caseId,
        reviewer: String(answer.verdict),
        gold: expected,
      })
    }
  }

  const agreed = answered.length - disagreements.length
  return {
    ok: true,
    score: {
      method: 'per-case',
      cards: cards.length,
      agreed,
      /* 分母是**卡片数**（不是已答数）：没填的卡片**不得**被算成同意 */
      rate: cards.length === 0 ? Number.NaN : agreed / cards.length,
      disagreements,
      unanswered,
    },
  }
}

/** 方式乙：只记录声明本身，**不产生数字** */
export function scoreDeclarative(
  cards: readonly { readonly caseId: string }[],
  statement: string,
  namedItems: readonly string[] = [],
): DeclarativeScore {
  return {
    method: 'declarative',
    cards: cards.length,
    perCaseRate: 'N/A',
    statement,
    namedItems,
  }
}
