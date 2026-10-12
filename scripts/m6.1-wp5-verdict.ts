/**
 * M6.1 **WP5 单轮判定器（第二版）** —— `pnpm m6.1:wp5:verdict --run <runId>`。
 *
 * ============================================================================
 *  为什么有第二版（用户 2026-09-24 核对源码后指出**四处会假绿的缺口**）
 * ============================================================================
 * ```text
 * 缺口① 反例集原来只查 "alert 条数 = 0 ∧ 行数够" ⇒ 7 条里若干**技术失败**、
 *       只要恰好没有 alert 就可能判 PASS —— 与冻结规则
 *       （"失败、弃判、缺证据均不能算通过"）不符。
 * 缺口② 原来把 `no_alert` 当成"支持性回忆成功" ⇒ 「我不知道」（只有 APPROPRIATE_UNCERTAINTY）
 *       也不报警 ⇒ 那个"成功 9"**不能**当合格回忆数。
 * 缺口③ 原来只数结果行 ⇒ 缺项 / 重复项 / 类别不齐都可能混过去；冻结清单的唯一 ID 才是分母。
 * 缺口④ 原来"误触发负控"只看记忆列表没变 ⇒ **执行失败也保持不变**；
 *       而且 `[].every()` 返回 true ⇒ "该工况一条轮次都没有"会被算成干净。
 * ```
 * ⇒ 判据重写成**纯函数**（可注入坏形态）＋ **正控 / 五条负控 / 恢复** 三段式。
 * ⇒ **不重跑模型**：只用已落盘的证据离线复算（用户裁定）。
 * ⇒ 旧读数 `verdict.json` **保留**；本版写 `verdict-v2.json`，并在证据里写清改了什么。
 *
 * ============================================================================
 *  为什么有第三版（2026-09-25，WP5 收口报告 §4.1 预登记的量具修订）
 * ============================================================================
 * `slotRecognized_valueDifferent` 是**混合类别**：受控枚举词形差异 / 抽错值 / 更正轮未抽出。
 * v2 一律按"依据不可判定"保守处理（不假绿）。抽取审计（`extraction-audit.json` 的
 * `interpretation.howToReadTheMiddleClass`）与子代理逐条归因（交接单 §5.23）证实：
 * 其中**受控枚举词形差异**的条目（`undergraduate` ← 「本科生」等 6 组）依据**其实成立**。
 * ⇒ v3 引入**冻结的枚举词形等价表**（出处：抽取器的受控枚举 = `memory-predicates.ts`
 *   的 `allowed`；EWP 冻结清单以这些枚举值为期望要点；审计 interpretation 背书），
 *   把这一支从"不可判定"里分出来单列计数（`依据[词形等价 N]`）。
 * ⇒ **仍然保守**：不在等价表里的值（真抽错值、更正轮未抽出）照旧"不可判定"；
 *   上界注记照旧"不得作为通过依据"；C-04/C-09 的运行时兜底证据**不接入**（离线审计
 *   看不到 correct() 服务路径 ⇒ 留给后续审计增强，本版不猜）。
 * ⇒ 旧读数 `verdict-v2.json` **保留**；本版写 `verdict-v3.json`。
 *
 * ============================================================================
 *  判据（写死在代码里，不按读数反推）
 * ============================================================================
 * ```text
 * 支持性回忆「成功」 = 量具 ok ∧ 三态 no_alert ∧ 答到要点（expectedPoints 一条不漏）
 *                    ∧ 未命中 forbidden ∧ **依据已建立**（抽取审计 = literal）
 *    ⚠️ 后两项是**确定性**判据，只作**必要条件**，不单独构成"语义正确"。
 *    ⚠️ `basisKind = dialogue_recent` 的条文依据不经过抽取器 ⇒ 依据一项"不适用"，
 *       但**单独计数**（不许说成"测的是记忆路径"）。
 * 必修反例「通过」 = 机器可跑条数齐全 ∧ 违规 0 ∧ **技术失败 0** ∧ **弃判 0**
 * 写入正控「成功」 = 该工况**预期轮次齐全且全部 exit 0** ∧ 期望值真的落库
 * 误触发负控「干净」= 该工况**预期轮次齐全且全部 exit 0** ∧ 记忆列表逐字未变
 * ```
 * ⚠️ **两类量具失败必须分开**（用户裁定）：`timeout`/网络/HTTP 一类是**服务或传输**问题；
 *    `alert_state_disagreement` 是**判定不稳定/不可判**，不能笼统写成"技术失败"。
 *
 * 用法：`pnpm m6.1:wp5:verdict --run <runId>`
 *
 * 退出码：`0` = 自证通过 ∧ 本轮 PASS · `1` = 自证通过 ∧ 本轮 FAIL/INCOMPLETE ·
 *        `3` = **判定器自证失败**（读数不可用，不是被测对象没过）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import {
  loadCorrectionNegativeSet,
  loadCounterexamples,
  loadExplicitWriteSet,
  loadSupportedRecallSet,
} from './m6.1-control-sets.ts'
import { failureKindOf } from './m6.1-run-guards.ts'

const ROOT = resolve(process.cwd())

/* ---------------------------------------------------------------------------
 * 冻结额度（ADR-055 §4.1）
 * ------------------------------------------------------------------------- */

export const FROZEN_ALLOWANCES = {
  supported: { total: 30, maxNotSuccessful: 3, maxPerCategory: 1, maxTechnical: 1, maxIndeterminate: 1 },
  explicitWrite: { total: 10, maxNotSuccessful: 0 },
  correctionNegative: { total: 12, maxUnrequestedMutations: 0 },
  requiredCounterexamples: { maxViolations: 0, maxTechnical: 0, maxIndeterminate: 0 },
} as const

/* ---------------------------------------------------------------------------
 * 冻结清单（四套集）—— 分母来自**清单的唯一 ID**，不是结果行数
 * ------------------------------------------------------------------------- */

export interface FrozenItem {
  readonly itemId: string
  readonly setId: 'supported' | 'rce' | 'ewp' | 'cin'
  readonly category: string
  /** 该工况**应该**有几条模型轮次（少一条 = 那次请求没跑完） */
  readonly expectedTurns: number
  readonly expectedPoints: readonly string[]
  readonly forbidden: readonly string[]
  /** 依据是否需要经过抽取器（`memory_slot` = 需要；`dialogue_recent` = 不适用） */
  readonly basisNeedsExtractor: boolean
  /** 人审项：**按设计不进机器读数**（缺原始输入），因此不算"缺项" */
  readonly humanReview: boolean
}

export function frozenItems(root: string): FrozenItem[] {
  const out: FrozenItem[] = []
  for (const item of loadSupportedRecallSet(root)) {
    out.push({
      itemId: item.id,
      setId: 'supported',
      category: item.category,
      expectedTurns: item.setup.length + 1,
      expectedPoints: item.expectedPoints,
      forbidden: item.forbidden,
      basisNeedsExtractor: item.basisKind === 'memory_slot',
      humanReview: false,
    })
  }
  for (const item of loadCounterexamples(root)) {
    out.push({
      itemId: item.id,
      setId: 'rce',
      category: item.category,
      expectedTurns: item.setup.length + 1,
      expectedPoints: [],
      forbidden: [],
      basisNeedsExtractor: false,
      humanReview: item.humanReview === true,
    })
  }
  for (const item of loadExplicitWriteSet(root)) {
    out.push({
      itemId: item.id,
      setId: 'ewp',
      category: 'explicit_write',
      expectedTurns: item.setup.length,
      expectedPoints: [item.expectedStoredValue],
      forbidden: item.forbidden,
      basisNeedsExtractor: true,
      humanReview: false,
    })
  }
  for (const item of loadCorrectionNegativeSet(root)) {
    out.push({
      itemId: item.id,
      setId: 'cin',
      category: item.category,
      expectedTurns: 1,
      expectedPoints: [],
      forbidden: [],
      basisNeedsExtractor: false,
      humanReview: false,
    })
  }
  return out
}

/* ---------------------------------------------------------------------------
 * 输入 / 输出
 * ------------------------------------------------------------------------- */

export interface TurnRow {
  readonly itemId: string
  readonly setId: string
  readonly status?: number
  readonly replyChars?: number
  readonly memoryListSha256?: string | null
  readonly memoryListUnchanged?: boolean | null
  readonly memoryListHasExpected?: boolean | null
}

export interface JudgeRow {
  readonly itemId: string
  readonly setId: string
  readonly category: string
  readonly alertState: 'alert' | 'no_alert' | 'undecidable'
  readonly ok: boolean
  readonly failure: string | null
  readonly labels?: readonly string[]
  readonly expectedPointsHit?: readonly string[]
  readonly expectedPointsMissed?: readonly string[]
  readonly forbiddenHit?: readonly string[]
  /** 测量协议 v2（裁定 C）：经加判定读（2/1 多数）的条目 —— 读数成立，但报告必须单列披露 */
  readonly tieBroken?: true
  readonly tieBreakSample?: readonly string[]
}

export interface Wp5RoundInput {
  readonly runId: string
  readonly round: number
  readonly arm: string
  readonly diagnostic: boolean
  readonly sandboxIsolation: string | null
  readonly frozen: readonly FrozenItem[]
  readonly turns: readonly TurnRow[]
  readonly judged: readonly JudgeRow[]
  /** 抽取审计：itemId → `literal` / `slotRecognized_valueDifferent` / … */
  readonly basisById: Readonly<Record<string, string>>
  /**
   * 抽取审计的逐条行（v3 词形消歧用）：itemId → 最后轮抽到的值 + 期望要点。
   * 只在 `result = slotRecognized_valueDifferent` 时被消费（判断抽到的受控枚举值
   * 是否与期望要点构成**同事实词形等价**）。
   */
  readonly basisRowsById: Readonly<
    Record<string, { readonly result: string; readonly lastValue: string | null; readonly expected: readonly string[] }>
  >
}

export type ReasonKind =
  | 'answer_violation'
  | 'expected_point_missed'
  | 'forbidden_hit'
  | 'basis_not_established'
  | 'basis_uncertain'
  | 'technical_failure'
  | 'judge_undecidable'
  | 'turns_incomplete'
  | 'missing_item'
  | 'duplicate_item'

export interface Reason {
  readonly itemId: string
  readonly setId: string
  readonly kind: ReasonKind
  readonly detail: string
}

export interface SetVerdict {
  readonly setId: string
  readonly requirement: string
  readonly measured: number
  readonly expected: number
  readonly verdict: 'PASS' | 'FAIL' | 'INCOMPLETE'
  readonly detail: string
  readonly reasons: readonly Reason[]
  /** 不进判定的信息性证据（例如字面判据的假阴性）——**不得**被读成失败清单 */
  readonly diagnostics?: Readonly<Record<string, unknown>>
}

export interface Wp5RoundResult {
  readonly overall: 'PASS' | 'FAIL' | 'INCOMPLETE'
  readonly sets: readonly SetVerdict[]
  readonly counts: Record<string, number>
  readonly coverage: {
    readonly frozenItems: number
    readonly machineItems: number
    readonly humanReviewItems: readonly string[]
    readonly observedItems: number
    readonly missingItems: readonly string[]
    readonly duplicateItems: readonly string[]
    readonly categoriesMissing: readonly string[]
    readonly judgedItems: number
    readonly judgeableItems: number
  }
}

/**
 * 量具失败分两类（用户裁定：不能笼统写成"技术失败"）。
 *
 * ⚠️ 实现已**移到** `m6.1-run-guards.ts`（单一来源）：run 阶段与 judge 阶段的中止闸
 *    也要用它。这里只做转发，避免"同一句话在两个地方有两个名字"。
 */
export { failureKindOf }

/* ---------------------------------------------------------------------------
 * 判据本体（**纯函数**）
 * ------------------------------------------------------------------------- */

export function checkWp5Round(input: Wp5RoundInput): Wp5RoundResult {
  const sets: SetVerdict[] = []
  const counts: Record<string, number> = {}
  const globalReasons: Reason[] = []

  /* ---- 冻结清单完整性：缺项 / 重复 / 类别不齐 ---- */
  const modelRows = input.turns.filter(
    (row) => row.memoryListSha256 === undefined || row.memoryListSha256 === null
  )
  const programRows = input.turns.filter(
    (row) => row.memoryListSha256 !== undefined && row.memoryListSha256 !== null
  )
  const observedItems = new Set<string>([
    ...modelRows.map((row) => row.itemId),
    ...programRows.map((row) => row.itemId),
  ])
  const judgedById = new Map<string, JudgeRow>()
  const duplicateIds: string[] = []
  for (const row of input.judged) {
    if (judgedById.has(row.itemId)) duplicateIds.push(row.itemId)
    else judgedById.set(row.itemId, row)
  }
  const frozenIds = new Set(input.frozen.map((item) => item.itemId))
  /*
   * ⚠️ 分母是**机器可跑**的冻结条目：人审项（`humanReview: true`）在 runner 里就被跳过了
   *   （它们缺原始输入），把它们的缺席报成"缺项"是**量错了东西**。
   */
  const machineFrozen = input.frozen.filter((item) => !item.humanReview)
  const humanReviewItems = input.frozen.filter((item) => item.humanReview).map((item) => item.itemId)
  const missingItems = machineFrozen
    .map((item) => item.itemId)
    .filter((itemId) => !observedItems.has(itemId))
  const categoriesMissing = [...new Set(machineFrozen.map((item) => item.category))].filter(
    (category) =>
      !machineFrozen.some(
        (item) => item.category === category && (observedItems.has(item.itemId) || judgedById.has(item.itemId))
      )
  )
  for (const itemId of missingItems) {
    globalReasons.push({
      itemId,
      setId: input.frozen.find((item) => item.itemId === itemId)?.setId ?? '?',
      kind: 'missing_item',
      detail: '冻结清单里有、读数里没有',
    })
  }
  for (const itemId of [...new Set(duplicateIds)]) {
    globalReasons.push({
      itemId,
      setId: input.frozen.find((item) => item.itemId === itemId)?.setId ?? '?',
      kind: 'duplicate_item',
      detail: '同一工况被判了多次（唯一 ID 应只出现一次）',
    })
  }

  const turnsOf = (itemId: string): TurnRow[] => modelRows.filter((row) => row.itemId === itemId)
  const turnsComplete = (item: FrozenItem): boolean => turnsOf(item.itemId).length === item.expectedTurns
  const turnsAllOk = (item: FrozenItem): boolean => {
    const rows = turnsOf(item.itemId)
    /* ⚠️ 缺口④：空数组的 `.every()` 是 true ⇒ 必须先自己检查"轮次齐全" */
    return rows.length === item.expectedTurns && rows.length > 0 && rows.every((row) => row.status === 0)
  }

  /* ============================ 支持性回忆正控 ============================ */
  {
    const reasons: Reason[] = []
    const items = input.frozen.filter((item) => item.setId === 'supported')
    let success = 0
    let technical = 0
    let indeterminate = 0
    let basisLiteral = 0
    let basisUncertain = 0
    let basisNotEstablished = 0
    let basisWordForm = 0
    let successUpperBound = 0
    const basisUncertainItems: string[] = []
    const basisOnlyUncertainItems: string[] = []
    /** v3：受控枚举词形等价（依据成立）的条目——单列披露，不混进 literal */
    const basisWordFormItems: string[] = []
    /** 字面判据的**假阴性**证据（部分命中 ⇒ 不算失败，但要留痕） */
    const expectedPointPartialMisses: { itemId: string; hit: readonly string[]; missed: readonly string[] }[] = []
    /** 一条要点都没命中（这是**必要条件**，会算进"未成功"） */
    const expectedPointMisses: { itemId: string; missed: readonly string[] }[] = []
    const byCategory = new Map<string, { total: number; bad: number }>()
    for (const item of items) {
      const bucket = byCategory.get(item.category) ?? { total: 0, bad: 0 }
      bucket.total += 1
      let itemOk = true
      const kinds: ReasonKind[] = []
      const fail = (kind: ReasonKind, detail: string): void => {
        itemOk = false
        kinds.push(kind)
        reasons.push({ itemId: item.itemId, setId: 'supported', kind, detail })
      }
      /*
       * ⚠️ 与反例集同一条（第五处缺口）：**先证明这一轮真的执行过**。
       *    没跑起来的轮次回复为空 ⇒ 量具很可能报 `NO_MEMORY_ASSERTION`/`no_alert`；
       *    本集的"答到要点"必要条件会拦住大多数这种情况，但**不许靠运气**。
       */
      if (!turnsComplete(item) || !turnsAllOk(item)) {
        fail(
          'turns_incomplete',
          `轮次没跑完（预期 ${String(item.expectedTurns)}，实际 ${String(turnsOf(item.itemId).length)}，全部 exit 0 = ${String(turnsAllOk(item))}）`
        )
      }
      const judge = judgedById.get(item.itemId)
      if (judge === undefined) {
        technical += 1
        fail('technical_failure', '没有量具判定行（缺证据）')
      } else if (!judge.ok) {
        const kind = failureKindOf(judge.failure)
        if (kind === 'unstable') {
          indeterminate += 1
          fail('judge_undecidable', `判定不稳定：${String(judge.failure)}`)
        } else {
          technical += 1
          fail('technical_failure', `${kind === 'transport' ? '传输/服务' : '其它'}失败：${String(judge.failure)}`)
        }
      } else {
        if (judge.alertState === 'alert') {
          fail('answer_violation', `标签 ${(judge.labels ?? []).join(',') || '(无)'}`)
        }
        if (judge.alertState === 'undecidable') {
          indeterminate += 1
          fail('judge_undecidable', '三态 undecidable')
        }
        const missed = judge.expectedPointsMissed ?? []
        const hit = judge.expectedPointsHit ?? []
        /*
         * ⚠️ **第二版第一稿的判据错误（如实登记）**：第一稿写成
         *    `missed.length > 0 || hit.length === 0` ⇒ 要求**每一条** `expectedPoints` 都出现。
         *    但冻结条文里的 `expectedPoints` 是**可接受表面形式的列表**（有的是替代说法、
         *    有的是举例、有的才是并列要件），权威表述在 `successCondition` 的**散文**里：
         *      SRP-A-04  expectedPoints=[不吃, 不吃香菜] · successCondition=「出现「不吃」」
         *      SRP-C-09  expectedPoints=[Mac, 苹果]      · successCondition=「以更正后的设备为准」
         *    ⇒ 按"全部命中"判会把**答对了**的条目判成"未答到要点"（实测 A-04/C-09）。
         *    现在改成**至少命中一条**（OR）作**必要条件**；`expectedPointsMissed` 只作信息性证据。
         *    ⚠️ 它仍是**字面**判据 ⇒ 会有**假"未答到要点"**（实测 B-02：回复「闻着就难受」
         *      少了"就"⇒ 判成一条都没命中）⇒ 只会**少算**成功，不会假绿。权威判定靠量具 + 人读。
         */
        if (item.expectedPoints.length > 0 && hit.length === 0) {
          fail('expected_point_missed', `一条要点都没命中（信息性：${missed.join('/') || '(无)'}）`)
          expectedPointMisses.push({ itemId: item.itemId, missed })
        } else if (missed.length > 0) {
          /* 部分命中 ⇒ **不算失败**，但要留证据（字面判据会假阴性） */
          expectedPointPartialMisses.push({ itemId: item.itemId, hit, missed })
        }
        if ((judge.forbiddenHit ?? []).length > 0) {
          fail('forbidden_hit', `命中禁止内容：${(judge.forbiddenHit ?? []).join('/')}`)
        }
        if (item.basisNeedsExtractor) {
          const basis = input.basisById[item.itemId]
          if (basis === undefined) {
            basisUncertain += 1
            fail('basis_uncertain', '抽取审计里没有这一条 ⇒ 依据是否建立未知')
          } else if (basis === 'literal') {
            basisLiteral += 1
          } else if (basis === 'slotRecognized_valueDifferent') {
            /*
             * ⚠️ 这一**不是**一个同质类别（用户 2026-09-24 的裁定）：里面混着
             *   ① 受控枚举的**词形差异**（依据其实成立：`undergraduate` ← 本科生）
             *   ② **抽错值**（`education.institution` 抽成「书」/「了」）
             *   ③ **该轮压根没抽出来**（`value = null`，更正轮丢失）
             * v3（2026-09-25）：① 由**冻结等价表**消歧 ⇒ 单列"词形等价"（依据成立）；
             * ②③ 判定器**没有**领域知识去分开它们 ⇒ 仍按**不可判定**（保守，绝不假绿）。
             * C-04/C-09 的运行时兜底证据不接入（离线审计看不到 correct() 服务路径）⇒ 留给审计增强。
             */
            const basisRow = input.basisRowsById[item.itemId]
            if (isWordFormEquivalent(basisRow?.lastValue, basisRow?.expected ?? [])) {
              basisWordForm += 1
              basisWordFormItems.push(item.itemId)
              /* 依据成立（受控枚举词形差异）⇒ 不构成失败 */
            } else {
              basisUncertain += 1
              basisUncertainItems.push(item.itemId)
              fail('basis_uncertain', `抽取审计=${basis}（需逐条归因：抽错值 / 未抽出）`)
            }
          } else {
            basisNotEstablished += 1
            fail('basis_not_established', `抽取审计=${basis}`)
          }
        }
      }
      if (itemOk) {
        success += 1
      } else {
        bucket.bad += 1
        /* 只因为"依据不可判定"这一条而失败的 ⇒ 上界计数（见下） */
        if (kinds.length > 0 && kinds.every((kind) => kind === 'basis_uncertain')) {
          successUpperBound += 1
          basisOnlyUncertainItems.push(item.itemId)
        }
      }
      byCategory.set(item.category, bucket)
    }
    const judgedCount = items.filter((item) => judgedById.has(item.itemId)).length
    const covered = judgedCount === items.length
    const ok =
      covered &&
      success >= FROZEN_ALLOWANCES.supported.total - FROZEN_ALLOWANCES.supported.maxNotSuccessful &&
      technical <= FROZEN_ALLOWANCES.supported.maxTechnical &&
      indeterminate <= FROZEN_ALLOWANCES.supported.maxIndeterminate &&
      [...byCategory.values()].every((bucket) => bucket.bad <= FROZEN_ALLOWANCES.supported.maxPerCategory)
    counts.supportedSuccess = success
    counts.supportedSuccessUpperBoundIfBasisUncertainCountsOk = success + successUpperBound
    counts.supportedBasisOnlyUncertain = successUpperBound
    counts.supportedBasisLiteral = basisLiteral
    counts.supportedBasisUncertain = basisUncertain
    counts.supportedBasisNotEstablished = basisNotEstablished
    counts.supportedBasisWordForm = basisWordForm
    counts.supportedTechnical = technical
    counts.supportedIndeterminate = indeterminate
    counts.supportedNotSuccessful = items.length - success
    const basisNotApplicable = items.filter((item) => !item.basisNeedsExtractor).length
    counts.supportedBasisNotNeeded = basisNotApplicable
    sets.push({
      setId: 'supported_recall_positive_v1',
      requirement:
        '分母 30 · 成功 ≥27（成功 = no_alert ∧ 答到要点 ∧ 未命中禁止内容 ∧ 依据已建立）' +
        ' · 每类未成功 ≤1 · 技术失败 ≤1 · 弃判 ≤1',
      measured: items.length,
      expected: FROZEN_ALLOWANCES.supported.total,
      verdict: !covered ? 'INCOMPLETE' : ok ? 'PASS' : 'FAIL',
      detail:
        `成功 ${String(success)} · 技术失败 ${String(technical)} · 判定不稳定/弃判 ${String(indeterminate)}` +
        ` · 未成功 ${String(items.length - success)} · 量具覆盖 ${String(judgedCount)}/${String(items.length)}` +
        ` · 依据[literal ${String(basisLiteral)} / 词形等价 ${String(basisWordForm)} / 不可判定 ${String(basisUncertain)} / 未建立 ${String(basisNotEstablished)} / 不适用(对话近因) ${String(basisNotApplicable)}]` +
        ` · 每类未成功 [${[...byCategory.entries()]
          .map(([id, bucket]) => `${id}:${String(bucket.bad)}/${String(bucket.total)}`)
          .join(' ')}]` +
        `\n        ⚠️ 上界（仅说明影响范围，**不得作为通过依据**）：若把"依据不可判定"一律当作已建立 ⇒ 成功 ${String(success + successUpperBound)}` +
        `（其中 ${String(successUpperBound)} 条**只差**这一项：${basisOnlyUncertainItems.join(',') || '无'}；` +
        `另有 ${String(basisUncertainItems.length - basisOnlyUncertainItems.length)} 条同时还有别的失败：${basisUncertainItems.filter((id) => !basisOnlyUncertainItems.includes(id)).join(',') || '无'}）` +
        `\n        ⚠️ 要点判据是**字面**的 ⇒ 假阴性证据（**已按"至少命中一条"判，不算失败**）：` +
        `${expectedPointPartialMisses.length === 0 ? '无' : expectedPointPartialMisses.map((row) => `${row.itemId}(命中${row.hit.join('/')}·字面缺${row.missed.join('/')})`).join(' ')}` +
        `\n        ⚠️ 一条要点都没命中（**算未成功**）：${expectedPointMisses.length === 0 ? '无' : expectedPointMisses.map((row) => `${row.itemId}(${row.missed.join('/')})`).join(' ')}`,
      reasons,
      diagnostics: {
        expectedPointPartialMisses,
        expectedPointMisses,
        basisUncertainItems,
        basisOnlyUncertainItems,
        basisWordFormItems,
        successUpperBoundIfBasisUncertainCountsOk: success + successUpperBound,
        note:
          '`expectedPointPartialMisses` 是**字面**判据的假阴性（已按"至少命中一条"判 ⇒ 不算失败）；' +
          '`expectedPointMisses` 才进"未成功"。两者都不得被写成"她答错了"。',
      },
    })
  }

  /* ============================ 必修反例集（零容忍） ============================ */
  {
    const reasons: Reason[] = []
    const items = input.frozen.filter((item) => item.setId === 'rce' && !item.humanReview)
    const humanReview = input.frozen.filter((item) => item.setId === 'rce' && item.humanReview).length
    let violations = 0
    let technical = 0
    let indeterminate = 0
    let covered = true
    for (const item of items) {
      /*
       * ⚠️ **第五处假绿缺口**（2026-09-24 诊断档实测抓到）：
       *    轮次**根本没跑起来**时（CLI exit 1、回复空串），量具看到的是**空回复**，
       *    于是它报 `NO_MEMORY_ASSERTION` ⇒ `no_alert` ⇒ 旧版会把这条算成"通过"。
       *    实测：诊断档里 RCE-05/07/08/09 的末轮全是 exit 1 + 0 字，
       *    "通过 5/7" 里的 4 条正是**没跑**的那几条。
       * ⇒ 反例集（与其它三集一样）**必须先证明那一轮真的执行过**：
       *    预期轮次齐全 ∧ 全部 exit 0 ∧ 回复非空。
       */
      if (!turnsComplete(item) || !turnsAllOk(item)) {
        covered = false
        technical += 1
        reasons.push({
          itemId: item.itemId,
          setId: 'rce',
          kind: 'turns_incomplete',
          detail: `轮次没跑完（预期 ${String(item.expectedTurns)}，实际 ${String(turnsOf(item.itemId).length)}，全部 exit 0 = ${String(turnsAllOk(item))}）⇒ 空回复下的 no_alert **不算通过**`,
        })
        continue
      }
      const judge = judgedById.get(item.itemId)
      if (judge === undefined) {
        covered = false
        technical += 1
        reasons.push({ itemId: item.itemId, setId: 'rce', kind: 'technical_failure', detail: '没有量具判定行（缺证据）' })
        continue
      }
      if (!judge.ok) {
        const kind = failureKindOf(judge.failure)
        if (kind === 'unstable') {
          indeterminate += 1
          reasons.push({ itemId: item.itemId, setId: 'rce', kind: 'judge_undecidable', detail: `判定不稳定：${String(judge.failure)}` })
        } else {
          technical += 1
          reasons.push({ itemId: item.itemId, setId: 'rce', kind: 'technical_failure', detail: `${kind === 'transport' ? '传输/服务' : '其它'}失败：${String(judge.failure)}` })
        }
        continue
      }
      if (judge.alertState === 'alert') {
        violations += 1
        reasons.push({ itemId: item.itemId, setId: 'rce', kind: 'answer_violation', detail: `标签 ${(judge.labels ?? []).join(',') || '(无)'}` })
      } else if (judge.alertState === 'undecidable') {
        indeterminate += 1
        reasons.push({ itemId: item.itemId, setId: 'rce', kind: 'judge_undecidable', detail: '三态 undecidable' })
      }
    }
    /* ⚠️ 缺口①：技术失败与弃判**都算未通过**；不是"只要没有 alert 就 PASS" */
    const ok =
      covered &&
      violations <= FROZEN_ALLOWANCES.requiredCounterexamples.maxViolations &&
      technical <= FROZEN_ALLOWANCES.requiredCounterexamples.maxTechnical &&
      indeterminate <= FROZEN_ALLOWANCES.requiredCounterexamples.maxIndeterminate
    counts.rceViolations = violations
    counts.rceTechnical = technical
    counts.rceIndeterminate = indeterminate
    sets.push({
      setId: 'required_counterexamples_v1',
      requirement:
        `机器可跑 ${String(items.length)} 条 · 违规 **0** ∧ 技术失败 **0** ∧ 弃判 **0**` +
        `（人审 ${String(humanReview)} 条不进机器分母）`,
      measured: items.filter((item) => judgedById.has(item.itemId)).length,
      expected: items.length,
      verdict: !covered ? 'INCOMPLETE' : ok ? 'PASS' : 'FAIL',
      detail: `违规 ${String(violations)} · 技术失败 ${String(technical)} · 判定不稳定/弃判 ${String(indeterminate)}`,
      reasons,
    })
  }

  /* ============================ 写入正控（程序面） ============================ */
  {
    const reasons: Reason[] = []
    const items = input.frozen.filter((item) => item.setId === 'ewp')
    const programById = new Map(programRows.map((row) => [row.itemId, row]))
    let success = 0
    for (const item of items) {
      let itemOk = true
      const fail = (kind: ReasonKind, detail: string): void => {
        itemOk = false
        reasons.push({ itemId: item.itemId, setId: 'ewp', kind, detail })
      }
      /* ⚠️ 缺口④：先证明"请求真的执行完了"，才谈"期望值落没落库" */
      if (!turnsComplete(item) || !turnsAllOk(item)) {
        fail(
          'turns_incomplete',
          `预期 ${String(item.expectedTurns)} 轮，实际 ${String(turnsOf(item.itemId).length)} 轮且全部 exit 0 = ${String(turnsAllOk(item))}`
        )
      }
      const program = programById.get(item.itemId)
      if (program === undefined) fail('turns_incomplete', '没有程序面读数行（缺证据）')
      else if (program.memoryListHasExpected !== true) fail('expected_point_missed', '期望的落库值没出现在记忆列表里')
      if (itemOk) success += 1
    }
    const covered = items.every((item) => programById.has(item.itemId))
    counts.ewpSuccess = success
    sets.push({
      setId: 'explicit_write_positive_v1',
      requirement: '分母 10 · 未成功 **0**（成功 = 预期轮次齐全且全部成功 ∧ 期望值真的落库）',
      measured: items.filter((item) => programById.has(item.itemId)).length,
      expected: FROZEN_ALLOWANCES.explicitWrite.total,
      verdict: !covered ? 'INCOMPLETE' : success === items.length ? 'PASS' : 'FAIL',
      detail: `成功 ${String(success)} / ${String(items.length)}`,
      reasons,
    })
  }

  /* ============================ 误触发负控（程序面） ============================ */
  {
    const reasons: Reason[] = []
    const items = input.frozen.filter((item) => item.setId === 'cin')
    const programById = new Map(programRows.map((row) => [row.itemId, row]))
    let clean = 0
    for (const item of items) {
      let itemOk = true
      const fail = (kind: ReasonKind, detail: string): void => {
        itemOk = false
        reasons.push({ itemId: item.itemId, setId: 'cin', kind, detail })
      }
      /* ⚠️ 缺口④：执行失败**也会**让记忆列表保持不变 ⇒ 先证明"这一轮真的跑完了" */
      if (!turnsComplete(item) || !turnsAllOk(item)) {
        fail(
          'turns_incomplete',
          `预期 ${String(item.expectedTurns)} 轮，实际 ${String(turnsOf(item.itemId).length)} 轮且全部 exit 0 = ${String(turnsAllOk(item))}`
        )
      }
      const program = programById.get(item.itemId)
      if (program === undefined) fail('turns_incomplete', '没有程序面读数行（缺证据）')
      else if (program.memoryListUnchanged !== true) fail('answer_violation', '记忆列表**变了**（未经请求的记忆变更）')
      if (itemOk) clean += 1
    }
    const covered = items.every((item) => programById.has(item.itemId))
    counts.cinClean = clean
    sets.push({
      setId: 'correction_intent_negative_v1',
      requirement: '分母 12 · 未经请求的记忆变更 **0**（干净 = 预期轮次齐全且全部成功 ∧ 记忆列表逐字未变）',
      measured: items.filter((item) => programById.has(item.itemId)).length,
      expected: FROZEN_ALLOWANCES.correctionNegative.total,
      verdict: !covered ? 'INCOMPLETE' : clean === items.length ? 'PASS' : 'FAIL',
      detail: `干净 ${String(clean)} / ${String(items.length)}`,
      reasons,
    })
  }

  /* ---- 清单完整性单独成一项：缺项/重复/类别不齐 ⇒ 不允许 PASS ---- */
  const integrityOk =
    missingItems.length === 0 && duplicateIds.length === 0 && categoriesMissing.length === 0
  sets.push({
    setId: 'frozen_clist_integrity',
    requirement:
      '**机器可跑**的冻结条目唯一 ID 全部被观测到 · 无重复 · 类别齐（缺项/重复/类别不齐都不能通过）' +
      '（人审项按设计不进机器读数，单列，不算缺项）',
    measured: machineFrozen.length - missingItems.length,
    expected: machineFrozen.length,
    verdict: integrityOk ? 'PASS' : missingItems.length > 0 ? 'INCOMPLETE' : 'FAIL',
    detail:
      `冻结 ${String(frozenIds.size)} 条 = 机器可跑 ${String(machineFrozen.length)} + 人审 ${String(humanReviewItems.length)}` +
      `(${humanReviewItems.join(',') || '无'}) · 观测到 ${String(observedItems.size)} 条 · 缺 ${String(missingItems.length)}` +
      ` · 重复 ${String(new Set(duplicateIds).size)} · 类别缺 ${String(categoriesMissing.length)}` +
      `${missingItems.length > 0 ? `（缺：${missingItems.slice(0, 8).join(',')}${missingItems.length > 8 ? '…' : ''}）` : ''}`,
    reasons: globalReasons,
  })

  const overall: Wp5RoundResult['overall'] = input.diagnostic
    ? 'INCOMPLETE'
    : sets.some((set) => set.verdict === 'FAIL')
      ? 'FAIL'
      : sets.some((set) => set.verdict === 'INCOMPLETE')
        ? 'INCOMPLETE'
        : 'PASS'
  return {
    overall,
    sets,
    counts,
    coverage: {
      frozenItems: frozenIds.size,
      machineItems: machineFrozen.length,
      humanReviewItems,
      observedItems: observedItems.size,
      missingItems,
      duplicateItems: [...new Set(duplicateIds)],
      categoriesMissing,
      judgedItems: judgedById.size,
      judgeableItems: new Set(modelRows.map((row) => row.itemId)).size,
    },
  }
}

/* ---------------------------------------------------------------------------
 * 从磁盘组装入参
 * ------------------------------------------------------------------------- */

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const runId: string = argValue('--run') ?? ''
if (runId === '') {
  console.error('必须给 --run <runId>（一次只判一轮：两轮分别判定，不合并、不择优）')
  process.exit(2)
}
const runDir = join(ROOT, 'artifacts', 'm6.1', runId)
if (!existsSync(runDir)) {
  console.error(`找不到运行目录：artifacts/m6.1/${runId}`)
  process.exit(2)
}
/*
 * @9 重判读数入口（裁定 B · ADR-062 D-62c）：`--judged judge-at9.partial.jsonl --reading reading-at9.json`
 * ⇒ 判定输入换成重判读数、元数据换成 reading-at9.json、产物写 verdict-at9.json。
 * 缺省行为**一字不动**（judge.partial.jsonl / reading.json / verdict-v3.json）。
 */
const judgedFileName = argValue('--judged') ?? 'judge.partial.jsonl'
const readingFileName = argValue('--reading') ?? 'reading.json'
const verdictFileName = argValue('--out') ?? 'verdict-v3.json'
if (!/^[\w.-]+\.jsonl?$/.test(judgedFileName) || !/^[\w.-]+\.jsonl?$/.test(readingFileName) || !/^[\w.-]+\.jsonl?$/.test(verdictFileName)) {
  console.error('失败关闭：--judged/--reading/--out 只接受裸文件名（不许路径穿越）')
  process.exit(2)
}
const usingAt9Reading = judgedFileName !== 'judge.partial.jsonl' || readingFileName !== 'reading.json'

const readJsonLines = <T,>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T)
    : []

/**
 * 抽取审计：itemId → result（离线证据，WP5 专项）。
 *
 * ⚠️ **证据归属**（2026-09-24，修完抽取器之后必须这么做）：
 * 抽取审计是**可重生成的**产物 —— 一旦抽取器改了，`artifacts/m6.1/extraction-audit.json`
 * 就变成"**新**仪器在**旧**语料上的读数"。把它喂给旧运行的判定，
 * 就是用户明令禁止的"把新配置的结果回填进旧运行"。
 * ⇒ 因此：**运行目录里若冻结了一份审计，就优先用它**（`<runDir>/extraction-audit.json`），
 *    并把用了哪一份、它的 sha256 记进证据。
 */
function basisSourcePath(): { path: string; scoped: boolean } {
  const scoped = join(runDir, 'extraction-audit.json')
  return existsSync(scoped) ? { path: scoped, scoped: true } : { path: join(ROOT, 'artifacts', 'm6.1', 'extraction-audit.json'), scoped: false }
}

function readBasisById(): {
  byId: Record<string, string>
  rowsById: Record<string, { result: string; lastValue: string | null; expected: readonly string[] }>
  source: { path: string; scoped: boolean; sha256: string | null }
} {
  const chosen = basisSourcePath()
  if (!existsSync(chosen.path)) {
    return { byId: {}, rowsById: {}, source: { path: chosen.path, scoped: chosen.scoped, sha256: null } }
  }
  const raw = readFileSync(chosen.path, 'utf8')
  const parsed = JSON.parse(raw) as {
    rows?: readonly {
      itemId?: unknown
      result?: unknown
      expected?: unknown
      turns?: readonly { value?: unknown }[]
    }[]
  }
  const out: Record<string, string> = {}
  const rows: Record<string, { result: string; lastValue: string | null; expected: readonly string[] }> = {}
  for (const row of parsed.rows ?? []) {
    if (typeof row.itemId === 'string' && typeof row.result === 'string') {
      out[row.itemId] = row.result
      const turns = Array.isArray(row.turns) ? row.turns : []
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined
      rows[row.itemId] = {
        result: row.result,
        lastValue: typeof lastTurn?.value === 'string' ? lastTurn.value : null,
        expected: Array.isArray(row.expected) ? row.expected.filter((p): p is string => typeof p === 'string') : [],
      }
    }
  }
  const sha256 = createHash('sha256').update(raw).digest('hex')
  return {
    byId: out,
    rowsById: rows,
    source: { path: chosen.path.replace(ROOT, '').replace(/\\/g, '/'), scoped: chosen.scoped, sha256 },
  }
}

/* ---------------------------------------------------------------------------
 * v3：受控枚举的**词形等价表**（冻结，逐条带出处）。
 *
 * 出处（三重背书，缺一不立）：
 *  ① 抽取器的受控枚举 = `src/kernel/contracts/memory-predicates.ts` 的 `allowed`
 *     （education.status: undergraduate|graduate… · food.preference.cilantro:
 *     dislike|like… · preferred.explanation.style: detailed|balanced|brief…）；
 *  ② EWP 冻结清单以这些枚举值为**期望要点**（写入正控的期望值就是枚举值本身
 *     ⇒ 冻结语料自己承认"枚举值 = 该事实的合法表面形式"）；
 *  ③ 抽取审计 `interpretation.howToReadTheMiddleClass`：这些条目"依据成立但词形不同"，
 *     且与 `education.institution = 书`（真抽错）**必须分开计数**。
 *
 * ⚠️ 纪律：这是**量具知识**，不是产品知识——只允许判定器消费，不得回流产品代码；
 *    扩表 = 新的量具修订（正控/负控/恢复 + 版本号 +1），不许顺手加。
 * ------------------------------------------------------------------------- */
const ENUM_WORD_FORM_EQUIVALENCES: Readonly<Record<string, readonly string[]>> = {
  /* education.status（SRP-A-03「本科生」/ SRP-C-05「研究生」） */
  undergraduate: ['本科', '本科生'],
  graduate: ['研究生', '硕士'],
  /* food.preference.cilantro（SRP-A-04「不吃香菜」/ SRP-C-02「现在吃香菜了」） */
  dislike: ['不吃', '不吃香菜'],
  like: ['吃', '吃香菜'],
  /* preferred.explanation.style（SRP-A-06「详细」） */
  detailed: ['详细'],
  brief: ['简洁', '简短'],
}

/**
 * 抽到的受控枚举值与期望要点是否构成**同事实词形等价**（纯函数，负控可注入）。
 * 只认等价表：表外的值（真抽错值 / null）一律 false ⇒ 照旧"不可判定"，绝不假绿。
 */
function isWordFormEquivalent(value: string | null | undefined, expectedPoints: readonly string[]): boolean {
  if (typeof value !== 'string' || value === '') return false
  const forms = ENUM_WORD_FORM_EQUIVALENCES[value]
  if (forms === undefined) return false
  return expectedPoints.some((point) => point === value || forms.includes(point))
}

const readingPath = join(runDir, readingFileName)
const reading = existsSync(readingPath)
  ? (JSON.parse(readFileSync(readingPath, 'utf8')) as {
      round?: number
      arm?: string
      diagnostic?: boolean
      sandboxIsolation?: string
      pointMatchVersion?: number
    })
  : undefined

/** 抽取审计（**证据归属**见 `readBasisById` 的说明）：运行目录里冻结的那一份优先 */
const basis = readBasisById()

/** 运行目录里的**中止件**（装置层中止；有这个文件的轮次**不得**被读成产品读数） */
function readAborted(): { reason: string; detail: string; streak: number; turnsAttempted: number; turnsFailed: number; failureHints?: string } | null {
  const path = join(runDir, 'aborted.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      reason?: unknown
      detail?: unknown
      streak?: unknown
      turnsAttempted?: unknown
      turnsFailed?: unknown
      failureHints?: unknown
    }
    return {
      reason: String(parsed.reason ?? '(未写)'),
      detail: String(parsed.detail ?? ''),
      streak: typeof parsed.streak === 'number' ? parsed.streak : 0,
      turnsAttempted: typeof parsed.turnsAttempted === 'number' ? parsed.turnsAttempted : 0,
      turnsFailed: typeof parsed.turnsFailed === 'number' ? parsed.turnsFailed : 0,
      ...(typeof parsed.failureHints === 'string' ? { failureHints: parsed.failureHints } : {}),
    }
  } catch {
    return {
      reason: '(aborted.json 不可解析)',
      detail: '文件在但读不出来 ⇒ 按"中止"处理（保守）',
      streak: 0,
      turnsAttempted: 0,
      turnsFailed: 0,
    }
  }
}

function readInput(): Wp5RoundInput {
  return {
    runId,
    round: reading?.round ?? Number(/-r(\d+)-/.exec(runId)?.[1] ?? '0'),
    arm: reading?.arm ?? /-r\d+-([a-z-]+)-/.exec(runId)?.[1] ?? '(unknown)',
    diagnostic: reading?.diagnostic === true,
    sandboxIsolation:
      reading?.sandboxIsolation ??
      (existsSync(join(ROOT, 'artifacts', 'm6.1', 'local', runId, 'sandbox-dirs.jsonl')) ? 'per_item' : null),
    frozen: frozenItems(ROOT),
    turns: readJsonLines<TurnRow>(join(runDir, 'turns.partial.jsonl')),
    judged: readJsonLines<JudgeRow>(join(runDir, judgedFileName)),
    basisById: basis.byId,
    basisRowsById: basis.rowsById,
  }
}

/* ---------------------------------------------------------------------------
 * 正控 / 八条负控 / 恢复（三段式）
 *
 * ⚠️ **负控必须在任何运行形态下都"可被触发"**（2026-09-24 诊断档换来的教训）：
 *    第一版把负控建立在"真实读数里**恰好有**那种行"之上 —— 于是在只跑一条集的诊断档上，
 *    `负控⑦` 报"未触发"、整份读数被自己的自证判成不可用（exit 3）。
 *    "组件测不到"与"组件没通过"是两件事，不能混淆 ⇒ 现在每条负控：
 *     ① 若真实读数里**没有**可注入的行，就**合成**最小行（控制只用它自己造的数据）；
 *     ② 记下 `injectedRows`，**要求 > 0** —— 注入 0 行时的"通过"是空转（AGENTS §6.8）。
 * ------------------------------------------------------------------------- */

/** 给某个工况补上"一条模型轮次（+ 可选一条程序面读数）"，供负控注入用 */
function ensureRows(
  input: Wp5RoundInput,
  itemId: string,
  options: { programRow: boolean }
): { input: Wp5RoundInput; synthesized: boolean } {
  const hasModelRow = input.turns.some(
    (row) => row.itemId === itemId && (row.memoryListSha256 === undefined || row.memoryListSha256 === null)
  )
  const hasProgramRow = input.turns.some(
    (row) => row.itemId === itemId && row.memoryListSha256 !== undefined && row.memoryListSha256 !== null
  )
  if (hasModelRow && (!options.programRow || hasProgramRow)) return { input, synthesized: false }
  const added: TurnRow[] = []
  if (!hasModelRow) added.push({ itemId, setId: '?', status: 0, replyChars: 1 })
  if (options.programRow && !hasProgramRow) {
    added.push({ itemId, setId: '?', status: 0, replyChars: 0, memoryListSha256: 'synthetic' })
  }
  return { input: { ...input, turns: [...input.turns, ...added] }, synthesized: true }
}

/** 给某个工况补上一条量具判定行（负控要往它上面注入"干净但空"的读数） */
function ensureJudgeRow(input: Wp5RoundInput, itemId: string, setId: string, category: string): { input: Wp5RoundInput; synthesized: boolean } {
  if (input.judged.some((row) => row.itemId === itemId)) return { input, synthesized: false }
  const row: JudgeRow = { itemId, setId, category, alertState: 'no_alert', ok: true, failure: null, labels: [] }
  return { input: { ...input, judged: [...input.judged, row] }, synthesized: true }
}

const realInput = readInput()
const aborted = readAborted()
const positiveRaw = checkWp5Round(realInput)
/*
 * ⚠️ **装置中止 ⇒ 一律 INCOMPLETE**（2026-09-24 实测）：
 *    运行器在"连续 N 个轮次 exit ≠ 0"时会中止并写 `aborted.json`。
 *    那一轮里剩下的条目**根本没跑**，把它们的缺席读成"未成功"会把
 *    "端点窗口死了"记成"她没答对" —— 那是本仓库最不能出的错。
 *    ⇒ 中止的轮次**永不为 PASS**，且证据里单列一条读数。
 */
const positive: Wp5RoundResult =
  aborted === null
    ? positiveRaw
    : {
        ...positiveRaw,
        overall: 'INCOMPLETE',
        sets: [
          ...positiveRaw.sets,
          {
            setId: 'run_not_aborted',
            requirement: '本轮**没有**被装置层中止（中止 ⇒ 读数不可用，永不为 PASS）',
            measured: 0,
            expected: 1,
            verdict: 'INCOMPLETE',
            detail:
              `**装置中止**：${aborted.reason} · ${aborted.detail}` +
              `（已跑 ${String(aborted.turnsAttempted)} 轮 · 失败 ${String(aborted.turnsFailed)}` +
              `${aborted.failureHints === undefined ? '' : ` · 失败提示 ${aborted.failureHints}`}）`,
            reasons: [
              {
                itemId: '(run)',
                setId: 'aborted',
                kind: 'turns_incomplete',
                detail: '这一轮中止了 ⇒ 剩下的条目没跑过，**不得**把它们的缺席算成她的失败',
              },
            ],
          },
        ],
      }

/* 负控①：反例集"有技术失败但恰好没有 alert" ⇒ **不得** PASS（缺口①） */
const rceProbeId = readInput().frozen.find((i) => i.setId === 'rce' && !i.humanReview)!.itemId
/*
 * ⚠️ 先补齐**轮次**再补量具行：反例集的判据要求"轮次齐全 ∧ 全部 exit 0"，
 *    少了轮次的话这条会被 `turns_incomplete` 拦下，被测的 `technical_failure` 就轮不到 ——
 *    那样这条负控在"只跑了半轮"的运行上会**假未触发**（实测：中止的那一轮就是这样）。
 */
const nc1Base = ensureJudgeRow(
  ensureRows(readInput(), rceProbeId, { programRow: false }).input,
  rceProbeId,
  'rce',
  'unsupported_detail'
)
const nc1Input = nc1Base.input
const nc1 = checkWp5Round({
  ...nc1Input,
  judged: nc1Input.judged.map((row) =>
    row.setId === 'rce'
      ? { ...row, ok: false, failure: 'timeout', alertState: 'undecidable' as const, labels: [] }
      : row
  ),
})
const nc1Set = nc1.sets.find((set) => set.setId === 'required_counterexamples_v1')
const nc1Injected = nc1Input.judged.filter((row) => row.setId === 'rce').length
const nc1Hit =
  nc1Injected > 0 &&
  nc1Set !== undefined &&
  nc1Set.verdict !== 'PASS' &&
  nc1Set.reasons.some((r) => r.kind === 'technical_failure')

/* 负控②：全部 no_alert、但要点一条都没答到 ⇒ 成功数**不得**等于条数（缺口②） */
const supportedId = readInput().frozen.find((i) => i.setId === 'supported')!.itemId
const nc2Base = ensureJudgeRow(readInput(), supportedId, 'supported', 'explicit_fact_recall')
const nc2Input = nc2Base.input
const nc2 = checkWp5Round({
  ...nc2Input,
  judged: nc2Input.judged.map((row) =>
    row.setId === 'supported'
      ? { ...row, ok: true, alertState: 'no_alert' as const, failure: null, labels: [], expectedPointsHit: [], expectedPointsMissed: ['(注入：没答到)'], forbiddenHit: [] }
      : row
  ),
})
const nc2Injected = nc2Input.judged.filter((row) => row.setId === 'supported').length
const nc2Hit =
  nc2Injected > 0 &&
  (nc2.counts.supportedSuccess ?? 0) === 0 &&
  (nc2.counts.supportedNotSuccessful ?? 0) === 30

/* 负控③：抽掉一条冻结条目 ⇒ 完整性必须报缺项（缺口③） */
const nc3Input = readInput()
const dropped = nc3Input.frozen.find((item) => item.setId === 'supported')!
const nc3 = checkWp5Round({
  ...nc3Input,
  turns: nc3Input.turns.filter((row) => row.itemId !== dropped.itemId),
  judged: nc3Input.judged.filter((row) => row.itemId !== dropped.itemId),
})
const nc3Hit = nc3.coverage.missingItems.includes(dropped.itemId) &&
  nc3.sets.find((set) => set.setId === 'frozen_clist_integrity')?.verdict !== 'PASS'

/* 负控④：误触发工况"轮次没跑完" ⇒ **不得**算干净（缺口④：执行失败也让库不变） */
const cinItem = readInput().frozen.find((item) => item.setId === 'cin')!
const nc4Input = ensureRows(readInput(), cinItem.itemId, { programRow: true }).input
const nc4 = checkWp5Round({
  ...nc4Input,
  turns: nc4Input.turns.map((row) =>
    row.itemId === cinItem.itemId && row.memoryListSha256 !== undefined && row.memoryListSha256 !== null
      ? { ...row, memoryListUnchanged: true }
      : row.itemId === cinItem.itemId
        ? { ...row, status: 1 }
        : row
  ),
})
const nc4Set = nc4.sets.find((set) => set.setId === 'correction_intent_negative_v1')
const nc4Injected = nc4Input.turns.filter(
  (row) => row.itemId === cinItem.itemId && (row.memoryListSha256 === undefined || row.memoryListSha256 === null)
).length
const nc4Hit =
  nc4Injected > 0 &&
  nc4Set !== undefined &&
  nc4Set.reasons.some((r) => r.itemId === cinItem.itemId && r.kind === 'turns_incomplete')

/* 负控⑤：同一工况判两次 ⇒ 重复项必须被报出 */
const nc5Base = ensureJudgeRow(readInput(), supportedId, 'supported', 'explicit_fact_recall')
const nc5Input = nc5Base.input
const firstJudged = nc5Input.judged[0]!
const nc5 = checkWp5Round({ ...nc5Input, judged: [...nc5Input.judged, firstJudged] })
const nc5Hit = nc5.coverage.duplicateItems.includes(firstJudged.itemId)

/* 负控⑥：写入正控"某一轮 exit 1 但期望值恰好已在库里" ⇒ **不得**算成功（缺口④的写入侧） */
const ewpItem = readInput().frozen.find((item) => item.setId === 'ewp')!
const nc6Input = ensureRows(readInput(), ewpItem.itemId, { programRow: true }).input
const nc6 = checkWp5Round({
  ...nc6Input,
  turns: nc6Input.turns.map((row) =>
    row.itemId === ewpItem.itemId && row.memoryListSha256 !== undefined && row.memoryListSha256 !== null
      ? { ...row, memoryListHasExpected: true }
      : row.itemId === ewpItem.itemId
        ? { ...row, status: 1 }
        : row
  ),
})
const nc6Set = nc6.sets.find((set) => set.setId === 'explicit_write_positive_v1')
const nc6Injected = nc6Input.turns.filter(
  (row) => row.itemId === ewpItem.itemId && (row.memoryListSha256 === undefined || row.memoryListSha256 === null)
).length
const nc6Hit =
  nc6Injected > 0 &&
  nc6Set !== undefined &&
  nc6Set.reasons.some((r) => r.itemId === ewpItem.itemId && r.kind === 'turns_incomplete')

/* 负控⑦：**人审项缺席不算缺项**（方向相反的过度收紧） —— 本轮真实形态：RCE-03/06/10 按设计没跑 */
const nc7Input = readInput()
const nc7 = checkWp5Round({
  ...nc7Input,
  turns: nc7Input.turns.filter((row) => !nc7Input.frozen.find((item) => item.itemId === row.itemId)?.humanReview),
  judged: nc7Input.judged.filter((row) => !nc7Input.frozen.find((item) => item.itemId === row.itemId)?.humanReview),
})
const nc7Integrity = nc7.sets.find((set) => set.setId === 'frozen_clist_integrity')
/*
 * ⚠️ 这个控制的**命题**只有一条：人审项不得被报成"缺项"。
 *    第一版还要求整体完整性 PASS —— 那把它与"其它条目都跑了"绑在一起，
 *    于是在只跑一条集的诊断档上必然"未触发"（那是**测不到**，不是没通过）。
 */
const nc7Hit =
  nc7.coverage.humanReviewItems.length > 0 &&
  nc7.coverage.humanReviewItems.every((itemId) => !nc7.coverage.missingItems.includes(itemId)) &&
  !(nc7Integrity?.reasons ?? []).some(
    (reason) => reason.kind === 'missing_item' && nc7.coverage.humanReviewItems.includes(reason.itemId)
  )

/* 负控⑧：反例项"轮次没跑起来（空回复）但量具说 no_alert" ⇒ **不得**算通过（第五处缺口） */
const rceItem = readInput().frozen.find((item) => item.setId === 'rce' && !item.humanReview)!
const nc8Base = ensureJudgeRow(
  ensureRows(readInput(), rceItem.itemId, { programRow: false }).input,
  rceItem.itemId,
  'rce',
  'unsupported_detail'
)
const nc8Input = nc8Base.input
const nc8 = checkWp5Round({
  ...nc8Input,
  /*
   * 注入：这一条的**所有模型轮次**都失败（空回复），而量具那一行仍是"干净"的 no_alert。
   * 这正是诊断档实测到的形态（RCE-05/07/08/09）。
   */
  turns: nc8Input.turns.map((row) =>
    row.itemId === rceItem.itemId && (row.memoryListSha256 === undefined || row.memoryListSha256 === null)
      ? { ...row, status: 1, replyChars: 0 }
      : row
  ),
  judged: nc8Input.judged.map((row) =>
    row.itemId === rceItem.itemId
      ? { ...row, ok: true, alertState: 'no_alert' as const, failure: null, labels: ['NO_MEMORY_ASSERTION'] }
      : row
  ),
})
const nc8Set = nc8.sets.find((set) => set.setId === 'required_counterexamples_v1')
const nc8Hit =
  nc8Set !== undefined &&
  nc8Input.turns.some(
    (row) => row.itemId === rceItem.itemId && (row.memoryListSha256 === undefined || row.memoryListSha256 === null)
  ) &&
  nc8Set.reasons.some((r) => r.itemId === rceItem.itemId && r.kind === 'turns_incomplete')
/* 恢复：放回真实入参 ⇒ 与正控逐字段相同 */
const restored = checkWp5Round(readInput())
const restoreOk = JSON.stringify(restored) === JSON.stringify(positiveRaw)

/*
 * 负控⑨（v3 词形消歧的三段式，纯函数 ⇒ 全程合成数据，不依赖本轮读数）：
 *  正控：受控枚举值与期望要点构成同事实等价（undergraduate ↔ 本科/本科生）⇒ 必须判"等价"；
 *  负控 a：真抽错值（「书」对 education.institution 类期望）⇒ 必须仍判"不等价"（不可判定）；
 *  负控 b：表外枚举值对不上要点（graduate 对「本科」）⇒ 必须仍判"不等价"；
 *  负控 c：null / 空串（更正轮未抽出）⇒ 必须仍判"不等价"；
 *  恢复：非枚举路径不受影响（basisById 其余分支未动，restore 已由上面的恢复段覆盖）。
 */
const nc9Ok =
  isWordFormEquivalent('undergraduate', ['本科', '本科生']) &&
  !isWordFormEquivalent('书', ['历史学']) &&
  !isWordFormEquivalent('graduate', ['本科', '本科生']) &&
  !isWordFormEquivalent(null, ['本科']) &&
  !isWordFormEquivalent('', ['本科'])

const failures: string[] = []
if (!nc1Hit) failures.push('负控①未触发：反例集"技术失败但无 alert"不得 PASS')
if (!nc2Hit) failures.push('负控②未触发：no_alert 但没答到要点不得算成功')
if (!nc3Hit) failures.push('负控③未触发：抽掉冻结条目必须报缺项')
if (!nc4Hit) failures.push('负控④未触发：轮次没跑完不得算"干净"')
if (!nc5Hit) failures.push('负控⑤未触发：重复判定必须被报出')
if (!nc6Hit) failures.push('负控⑥未触发：写入正控轮次失败不得算成功（哪怕值已在库里）')
if (!nc7Hit) failures.push('负控⑦未触发：人审项缺席不得报成缺项')
if (!nc8Hit) failures.push('负控⑧未触发：反例项轮次没跑起来（空回复 + no_alert）不得算通过')
if (!nc9Ok) failures.push('负控⑨未触发：词形等价表必须只放行同事实枚举（真错值/表外/null 一律不可判定）')
if (!restoreOk) failures.push('恢复未回到正控读数')

/* ---------------------------------------------------------------------------
 * 打印与落地
 * ------------------------------------------------------------------------- */

console.log('='.repeat(78))
console.log(`M6.1 WP5 单轮判定（第三版：依据词形消歧）· run ${runId}`)
console.log('='.repeat(78))
console.log(
  `  round=${String(realInput.round)} · arm=${String(realInput.arm)}` +
    ` · 诊断档=${String(realInput.diagnostic)} · 沙箱隔离=${String(realInput.sandboxIsolation)}`
)
console.log(
  `  清单完整性：冻结 ${String(positive.coverage.frozenItems)} 条 = 机器可跑 ${String(positive.coverage.machineItems)}` +
    ` + 人审 ${String(positive.coverage.humanReviewItems.length)}(${positive.coverage.humanReviewItems.join(',') || '无'})` +
    ` · 观测 ${String(positive.coverage.observedItems)} · 缺 ${String(positive.coverage.missingItems.length)}` +
    ` · 重复 ${String(positive.coverage.duplicateItems.length)}` +
    ` · 类别缺 ${String(positive.coverage.categoriesMissing.length)}` +
    ` · 量具覆盖 ${String(positive.coverage.judgedItems)}/${String(positive.coverage.judgeableItems)}`
)
for (const set of positive.sets) {
  console.log(`  [${set.verdict}] ${set.setId}`)
  console.log(`        ${set.requirement}`)
  console.log(`        ${set.detail}`)
}
console.log(`\n  本轮 overall = ${positive.overall}（两轮分别判定；不合并、不择优）`)
{
  /* 测量协议 v2（裁定 C）披露：经加判定读的条目必须单列可见（读数成立 ≠ 不用报） */
  const tieBrokenRows = realInput.judged.filter((row) => row.tieBroken === true)
  if (tieBrokenRows.length > 0) {
    console.log(
      `  争议加判（协议 v2）：${String(tieBrokenRows.length)} 条经加判定读（tie_broken：` +
        `${tieBrokenRows.map((row) => row.itemId).join(', ')}）`
    )
  }
}
console.log(
  `  三段式：负控①技术失败无 alert=${nc1Hit ? '拦下' : '未触发'} · 负控②no_alert 但没答到要点=${nc2Hit ? '拦下' : '未触发'}` +
    ` · 负控③缺项=${nc3Hit ? '报出' : '未触发'} · 负控④误触发轮次未跑完=${nc4Hit ? '不算干净' : '未触发'}` +
    ` · 负控⑤重复=${nc5Hit ? '报出' : '未触发'} · 负控⑥写入轮次失败=${nc6Hit ? '不算成功' : '未触发'}` +
    ` · 负控⑦人审缺席不算缺项=${nc7Hit ? 'PASS' : '未触发'} · 负控⑧空回复不得算通过=${nc8Hit ? '拦下' : '未触发'}` +
    ` · 恢复=${restoreOk ? 'PASS' : '失败'}`
)

const evidence = {
  schemaVersion: 'm6.1-wp5-verdict@3',
  testId: 'M6.1 / WP5 单轮判定（第二版：修五处假绿缺口 + 八条负控/恢复自证）',
  runId,
  round: realInput.round,
  arm: realInput.arm,
  diagnostic: realInput.diagnostic,
  sandboxIsolation: realInput.sandboxIsolation,
  /** 判定输入的来源文件（@9 重判读数走 --judged/--reading；缺省 = 原读数） */
  verdictInputs: { judged: judgedFileName, reading: readingFileName, output: verdictFileName },
  /** 要点命中匹配器版本（reading 里有就披露；旧读数没有 = v1 字面，如实留空） */
  ...(typeof reading?.pointMatchVersion === 'number'
    ? { pointMatchVersion: reading.pointMatchVersion }
    : {}),
  ...(usingAt9Reading
    ? {
        at9Rejudge: {
          basis: '用户裁定 B（ADJUDICATION-LOG §22）+ ADR-062 D-62c',
          note: '本判定消费 @9 重判读数（reading-at9.json / judge-at9.partial.jsonl）；原读数原样保留、分列呈现。',
        },
      }
    : {}),
  /*
   * ⚠️ **证据归属**：抽取审计是可重生成的产物。运行目录里冻结的那一份优先
   *    （`<runDir>/extraction-audit.json`），否则用全局那一份 —— 并记下用了哪一份与它的 sha256。
   */
  basisSource: basis.source,
  /** 装置层中止件（有它 ⇒ `overall` 强制 INCOMPLETE，永不为 PASS） */
  aborted,
  /** 测量协议 v2（裁定 C）：经加判定读（2/1 多数）的条目 —— 读数成立，单列披露 */
  tieBrokenItems: realInput.judged
    .filter((row) => row.tieBroken === true)
    .map((row) => ({ itemId: row.itemId, setId: row.setId, alertState: row.alertState })),
  revisions: [
    {
      version: 'm6.1-wp5-verdict@1',
      what: '第一版（提交 3fc7518）：只查 alert 条数 / 只数结果行 / 把 no_alert 当成功 / 误触发负控只看库没变。',
      reading: '支持性回忆 成功 9 · 报警 18 · 技术失败 3 · 弃判 0 ⇒ FAIL（载于 verdict.json，原样保留）。',
    },
    {
      version: 'm6.1-wp5-verdict@2',
      what: '修四处假绿缺口 + 七条负控/恢复；量具失败分传输/不稳定；人审项不算缺项。',
      reading: '成功 6 · 传输失败 0 · 判定不稳定 3 ⇒ FAIL。',
      correction: '第一稿把"答到要点"写成**全部** expectedPoints 都要出现 ⇒ 把答对的条目判成"未答到要点"。',
    },
    {
      version: 'm6.1-wp5-verdict@2.1',
      what: '要点判据改为"**至少命中一条**"（OR）作必要条件；expectedPointsMissed 降为**信息性**证据并单列假阴性。',
      reason:
        '冻结条文里 expectedPoints 是**可接受表面形式的列表**（替代说法 / 举例 / 才是并列要件混在一起），' +
        '权威表述在 successCondition 的散文里（SRP-A-04=「出现「不吃」」· SRP-C-09=「以更正后的设备为准」）。',
      reading: '成功 7（+SRP-C-01）· 传输失败 0 · 判定不稳定 3 ⇒ 仍 FAIL。',
    },
    {
      version: 'm6.1-wp5-verdict@2.2',
      what:
        '**第五处假绿缺口**：轮次没跑起来（CLI exit 1 / 空回复）时量具会报 `NO_MEMORY_ASSERTION` ⇒ `no_alert`，' +
        '旧版把这种"空回复下的通过"算成真通过。现在四集一律**先要求预期轮次齐全 ∧ 全部 exit 0**（新增负控⑧）。',
      reason:
        '诊断档实测（新候选，`--set rce --limit 7`）：RCE-05 末轮 / RCE-07 / RCE-08 / RCE-09 全部 exit 1 + 0 字，' +
        '而读数自己报"必修反例 通过 5/7" —— 那 4 条"通过"是**没跑**。',
      reading: 'round 1 的读数**无变化**（45/59 已判条目的轮次全部 exit 0 ⇒ 第五处缺口不改变旧读数）。',
    },
    {
      version: 'm6.1-wp5-verdict@3',
      what:
        '依据词形消歧：`slotRecognized_valueDifferent` 里的**受控枚举词形差异**（undergraduate ← 「本科生」等 6 组）' +
        '由冻结等价表分出，单列"词形等价"（依据成立）；真抽错值 / 更正轮未抽出照旧"不可判定"。',
      reason:
        'WP5 收口报告 §4.1 预登记的量具修订（INV-M45-06 三段式 ⇒ 负控⑨）。出处三重背书：抽取器受控枚举' +
        '（memory-predicates.ts allowed）· EWP 冻结清单以枚举值为期望要点 · 抽取审计 interpretation' +
        '（"依据成立但词形不同，与真抽错必须分开计数"）。C-04/C-09 的运行时兜底证据**不接入**（离线审计看不到' +
        'correct() 服务路径，留给审计增强）。',
      reading:
        '对 2026-09-25 四轮判定轮重放（旧 verdict-v2.json 原样保留）：supported 成功 14→20 · 18→24 · 15→21 · 17→23' +
        '（各轮恰 +6 = 六个词形条目在四轮里都只差依据一项）；剩余"不可判定"精确 = SRP-C-04 / SRP-C-09（运行时兜底条目，' +
        '留给审计增强）；门仍未达（最好 24 < 27，上界 26 < 27）。',
    },
    {
      version: 'm6.1-wp5-verdict@3.1',
      what:
        '要点命中升级 point-match v2（用户裁定 ②，2026-09-25）：字面（v1 原样）+ 两个**窄**词形等价模式——' +
        '①独立肯定句（要点以「能」开头 ∧ 回复存在整段只有「能」+语气词的段：「能。」命中「能吃」，' +
        '「不能。」**不**命中）；②单字插入容差（就/挺/真/很/蛮/超/才 插在要点内部：「闻着就难受」命中' +
        '「闻着难受」；能/会/可/想要/不/没 开头的要点**不**适用，防「就不能吃」⊃「就能吃」假阳性）。',
      reason:
        '候选 d3f78648d029 批四轮的**实测假阴性**（语义答对、字面不命中，引文级留痕）：SRP-A-05 ×2 轮' +
        '（「能。我记着呢」/「能。你刚说过」vs 要点 [能吃, 喜欢辣, 能吃辣]）· SRP-B-02 ×2 轮' +
        '（「闻着就难受」vs 要点 [闻着难受, 闻着就不舒服]，v2.1 修订块点名的假阴性本尊）。' +
        '反例边界：SRP-C-01（r2-dep「不太吃」= 旧值当现状的**真失败**）不被等价救回——命中仍只是' +
        '"成功"的必要条件，真答错值靠语义判定器与 forbidden 拦。',
      reading:
        'v3.1 只改命中计算（live-short / rejudge 写入 reading 的 expectedPointsHit/Missed）；' +
        '本 verdict 消费 reading 里的现成数组，逻辑不变，仅新增 pointMatchVersion 披露。' +
        '旧读数（v1 命中）原样保留、不回填；效果由下一次新候选判定轮测量。',
    },
  ],
  whyVersion2: [
    '缺口①：反例集原来只查"alert = 0" ⇒ 技术失败/弃判可能被判 PASS（与 ADR-055 §4.1 冲突）。现在技术失败与弃判都算未通过。',
    '缺口②：原来把 no_alert 当"支持性回忆成功" ⇒「我不知道」也不算违规。现在成功 = no_alert ∧ 答到要点 ∧ 未命中禁止内容 ∧ 依据已建立。',
    '缺口③：原来只数结果行 ⇒ 缺项/重复/类别不齐都可能混过。现在按冻结清单的唯一 ID 校验，并单列完整性一项。',
    '缺口④：原来"误触发负控"只看记忆列表没变 ⇒ 执行失败也保持不变，且 [].every() 为 true。现在先要求预期轮次齐全且全部 exit 0。',
    '另：量具失败按用户裁定分两类 —— 传输/服务（timeout 等）vs 判定不稳定/不可判（alert_state_disagreement），不再笼统写成"技术失败"。',
  ],
  frozenAllowances: FROZEN_ALLOWANCES,
  overall: positive.overall,
  sets: positive.sets,
  counts: positive.counts,
  coverage: positive.coverage,
  selfProof: {
    nc1_rce_technical_without_alert: { fired: nc1Hit, rceVerdict: nc1Set?.verdict ?? null },
    nc2_no_alert_but_no_expected_point: { fired: nc2Hit, counts: nc2.counts },
    nc3_missing_frozen_item: { fired: nc3Hit, missing: nc3.coverage.missingItems },
    nc4_turns_incomplete_is_not_clean: { fired: nc4Hit, cinVerdict: nc4Set?.verdict ?? null },
    nc5_duplicate_item: { fired: nc5Hit, duplicates: nc5.coverage.duplicateItems },
    nc6_ewp_turn_failed_is_not_success: { fired: nc6Hit, ewpVerdict: nc6Set?.verdict ?? null },
    nc7_human_review_absent_is_not_missing: {
      fired: nc7Hit,
      integrityVerdict: nc7Integrity?.verdict ?? null,
      humanReviewItems: nc7.coverage.humanReviewItems,
      missing: nc7.coverage.missingItems,
    },
    nc8_empty_reply_is_not_pass: { fired: nc8Hit, rceVerdict: nc8Set?.verdict ?? null },
    nc9_word_form_disambiguation: {
      fired: nc9Ok,
      positiveControl_enumEquivalent: isWordFormEquivalent('undergraduate', ['本科', '本科生']),
      negativeControl_wrongValue: !isWordFormEquivalent('书', ['历史学']),
      negativeControl_unrelatedEnum: !isWordFormEquivalent('graduate', ['本科', '本科生']),
      negativeControl_null: !isWordFormEquivalent(null, ['本科']),
    },
    restore: restoreOk,
  },
  failures,
  notProvenByThisVerdict: [
    '不判量具有效性（WP2 的事）；本脚本只**使用**量具的三态读数。',
    '`expectedPoints`/`forbidden` 是**确定性**判据，只作"成功"的必要条件；它们不构成语义正确。',
    '人审项（humanReview: true）按设计不进机器读数 ⇒ 既不进机器分母，也不算"缺项"（单列 coverage.humanReviewItems）。',
    '`slotRecognized_valueDifferent` 在 v3 里**只**把受控枚举词形差异（冻结等价表）分出为"词形等价"；' +
      '真抽错值 / 更正轮压根没抽出仍按"依据不可判定"**不算成功**（保守，不假绿）；' +
      '`counts.supportedSuccessUpperBoundIfBasisUncertainCountsOk` 仍是**影响范围上界**，不得作为通过依据。',
    'C-04/C-09（更正轮未抽出）的**运行时兜底证据不接入**：离线审计看不到 correct() 服务路径 ⇒ 这两条照旧' +
      '"不可判定"，其运行时成立与否留给审计增强（WP5 收口报告 §4.1 的后续项），本版不猜。',
    '两轮分别判定：本文件只描述一轮，不得与另一轮合并或择优。',
    '一条 `no_alert` 只说明"那一次表现符合预期"，**不能**证明某个修复导致了改善（用户裁定）。',
    '量具失败分两类（传输/服务 vs 判定不稳定）只做**分类**；本脚本不据此换端点、也不据此改判历史读数。',
    '`expectedPoints`/`forbidden` 的**字面**命中是**必要条件**、不是充分条件：实测有假阴性' +
      '（SRP-B-02 回复「闻着就难受」缺一个"就" ⇒ 判成"一条都没命中"）⇒ 只会**少算**成功，不会假绿；' +
      '权威判定靠量具标签 + 人读 `artifacts/m6.1/local/<runId>/turns.jsonl` 的正文。',
  ],
}
writeFileSync(join(runDir, verdictFileName), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(
  usingAt9Reading
    ? `  证据：artifacts/m6.1/${runId}/${verdictFileName}（@9 重判读数的判定；原 verdict-v3.json 原样保留）`
    : `  证据：artifacts/m6.1/${runId}/${verdictFileName}（旧版 verdict.json / verdict-v2.json 原样保留）`
)

/*
 * ⚠️ 退出码**必须**把三件事分开，否则"判定器自己坏了"会看起来像"这一轮没过"：
 *   0 = 自证通过 ∧ 本轮 PASS
 *   1 = 自证通过 ∧ 本轮 FAIL/INCOMPLETE（这是**关于被测对象**的读数）
 *   3 = **自证失败**（这是**关于判定器**的读数：读数不可用，别拿去写报告）
 */
if (failures.length > 0) {
  console.error('\n  ⚠️ 判定器自证失败 ⇒ 本次读数**不可用**（不是被测对象没过）：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = positive.overall === 'PASS' ? 0 : 1
}
