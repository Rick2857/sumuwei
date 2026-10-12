/**
 * M6 / ADR-050 —— **轮次级摘要端口**（把"只读来源读取"与"选择器"串成一次调用）。
 *
 * ============================================================================
 *  为什么它必须只有一处（与 `app/recall/turn.ts` 同一条理由）
 * ============================================================================
 * ```text
 *   RollupSourceReader.read()   有界、只读地取候选来源（含受信读数与记忆状态）
 *     → selectRollup()          五道闸 + Recent 去重 + 预算试装 + 逐字渲染
 *     → RollupSelection         { blockText, sourceRefs, items, 计数, 拒绝分布 }
 * ```
 * 这几步的先后与参数若散落在调用点，迟早会出现"某一轮漏了失效闸"或
 * "某一轮把 Recent 也摘了一遍"这种**不报错**的缺陷 —— 而摘要的失效闸正是
 * `M5.1-D01` 那一类问题的防线。
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * 1. **零写入**：本模块只调只读端口与纯函数。它不认识任何写路径。
 * 2. **失败关闭**（`DR-10`）：读失败 / 读不到归因 / 形状坏 ⇒ **不注入**，
 *    并把降级理由如实放进 trace。**绝不**回落到"随手拼几条旧句子"。
 * 3. **进 trace 的形态不含正文**：`RollupTurnTrace` 里只有 id、计数与序列范围
 *    （`DR-9`）。它的类型里连 `blockText` 都没有 —— 于是"忘了用安全形态"
 *    这件事在类型上就写不出来。
 *
 * ⚠️ 本模块**不**决定"要不要摘要"：那是额度（`ContextBudget.rollupTokens`）的事。
 *    `budgetTokens <= 0` ⇒ 返回 `undefined` ⇒ 网关连 trace 都不写（普通对话不受影响）。
 */

import type { CharacterId } from '../../contracts/ids.ts'
import type { RollupRejectionCounts } from '../../contracts/rollup.ts'
import type { RollupSourceReader } from '../../recall/ports.ts'
import { selectRollup, type RollupSelection, type RollupTokenQuantifier } from '../../recall/rollup.ts'

/**
 * 扫描上限的**缺省值**。
 *
 * 它有界是硬性质（ADR-050 `DR-5`）：摘要永远只覆盖一个窗口，超限就如实标
 * `coverageTruncated`。定 200 的理由：它远大于 Recent 窗口（16），
 * 又远小于任何"全表扫描"，因此既是"能带回早期内容"的最小可用值，
 * 也不至于让一次轮次级读取变成规模测试。
 */
export const ROLLUP_SCAN_CEILING = 200

export type RollupTurnStatus =
  /** 正常求值过（可能选出 0 条：那是"窗口内没有合格来源"，不是失败） */
  | 'evaluated'
  /** 读取失败（端口抛了 / 形状坏）⇒ 本层失败关闭，不注入 */
  | 'read_failed'

export interface RollupTurnTrace {
  status: RollupTurnStatus
  selectorVersion: string
  /** 实际进入判定的来源条数（范围自检：0 与"没扫到"是两件事） */
  scannedEventCount: number
  itemCount: number
  /** 只有 `cev:<id>`，**没有正文** */
  sourceRefs: string[]
  coveredSequenceRange: { from: number; to: number } | null
  omittedEligibleCount: number
  skippedByRecentWindow: number
  coverageTruncated: boolean
  rejections: RollupRejectionCounts
  /**
   * 是否**真的进了 packet**。
   *
   * ⚠️ 本层只能声明"选择器产出了非空块"；真正进没进 packet 由网关在
   *    **编译器之后**修正 —— 因为摘要 section 是 `droppable: true`，
   *    编译器才是最终裁剪者（与召回那条链同样的理由）。
   */
  reachedContext: boolean
}

export interface RollupTurnOutcome {
  /** `undefined` = 没有可注入的块（读失败 / 窗口内无可选来源） */
  selection: RollupSelection | undefined
  trace: RollupTurnTrace
}

export interface RollupTurnRequest {
  readonly characterId: CharacterId
  readonly conversationId: string
  /** Recent 窗口里那些事件的 id（按来源 id 去重，Recent 优先） */
  readonly recentSourceEventIds: readonly string[]
  /**
   * **排他**下界：只取 `sequence < beforeSequence` 的来源。
   *
   * 为什么是"早于"而不是"晚于"：要保留的是**已经离开 Recent 窗口**的早期发言。
   * 近期对话本来就有原文进上下文，摘要是它的**替代品**，不是它的重复。
   *
   * （ADR-050 §3.2 的伪代码把这一行写成了 `sequence > watermark` —— 那是方向写反的
   *   笔误，裁定意图（"只覆盖 Recent 窗口之外"）不受影响。已登记为偏差 B-14。）
   */
  readonly beforeSequence: number
  /** 摘要额度（`ContextBudget.rollupTokens`）；`<= 0` ⇒ 本层直接返回 `undefined` */
  readonly budgetTokens: number
}

export interface RollupTurnPort {
  /** 这一轮要带哪些早期发言进上下文。**只读**（端口契约要求实现不得写任何表） */
  run(request: RollupTurnRequest): Promise<RollupTurnOutcome | undefined>
}

export interface RollupTurnPortOptions {
  reader: RollupSourceReader
  quantifier?: RollupTokenQuantifier
  scanCeiling?: number
}

function emptyTrace(status: RollupTurnStatus, selectorVersion: string): RollupTurnTrace {
  return {
    status,
    selectorVersion,
    scannedEventCount: 0,
    itemCount: 0,
    sourceRefs: [],
    coveredSequenceRange: null,
    omittedEligibleCount: 0,
    skippedByRecentWindow: 0,
    coverageTruncated: false,
    rejections: {
      out_of_scope: 0,
      non_user_source: 0,
      unconfirmed_origin: 0,
      contradicted_origin: 0,
      invalidated_by_memory_state: 0,
    },
    reachedContext: false,
  }
}

export function createRollupTurnPort(options: RollupTurnPortOptions): RollupTurnPort {
  const scanCeiling = options.scanCeiling ?? ROLLUP_SCAN_CEILING
  return {
    async run(request: RollupTurnRequest): Promise<RollupTurnOutcome | undefined> {
      // 额度 0 = 今天不做摘要（一个**真实配置**，不是"忘了填"）。连 trace 都不写。
      if (request.budgetTokens <= 0) return undefined

      let sources: Awaited<ReturnType<RollupSourceReader['read']>>
      try {
        sources = await options.reader.read({
          characterId: request.characterId,
          conversationId: request.conversationId,
          beforeSequence: request.beforeSequence,
          scanCeiling,
        })
      } catch {
        /*
         * `DR-10` 失败关闭：读取面挂了就**不注入**，并把降级理由写进 trace。
         * 注意这里**没有** catch-then-fallback：没有"读不到就少摘几条"这种路径。
         */
        return {
          selection: undefined,
          trace: emptyTrace('read_failed', ROLLUP_VERSION_NOT_EVALUATED),
        }
      }

      const selection = selectRollup({
        conversationId: request.conversationId,
        sources,
        recentSourceEventIds: request.recentSourceEventIds,
        scanCeiling,
        budgetTokens: request.budgetTokens,
        ...(options.quantifier !== undefined ? { quantifier: options.quantifier } : {}),
      })

      return {
        selection: selection.blockText.trim() === '' ? undefined : selection,
        trace: {
          status: 'evaluated',
          selectorVersion: selection.selectorVersion,
          scannedEventCount: selection.scannedEventCount,
          itemCount: selection.items.length,
          sourceRefs: [...selection.sourceRefs],
          coveredSequenceRange: selection.coveredSequenceRange,
          omittedEligibleCount: selection.omittedEligibleCount,
          skippedByRecentWindow: selection.skippedByRecentWindow,
          coverageTruncated: selection.coverageTruncated,
          rejections: selection.rejections,
          // 选择器产出了非空块 ⇒ 候选事实；是否真进 packet 由网关修正
          reachedContext: selection.blockText.trim() !== '',
        },
      }
    },
  }
}

/** 读失败时的版本占位：**没有求值过**，因此不能声称任何选择器版本 */
const ROLLUP_VERSION_NOT_EVALUATED = '(not-evaluated)'
