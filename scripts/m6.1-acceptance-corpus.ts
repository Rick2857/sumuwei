/**
 * M6.1 —— **验收语料的描述符**（版本 / 文件清单 / 语料身份 / 运行模式约束）。
 *
 * ⚠️ 它**不**在候选冻结件的判定链路清单里 —— 语料升版本只是运行配置的变动，
 * 不该让候选 id 跟着动。
 *
 * ============================================================================
 *  为什么它单独一个文件（不放在 m6.1-contract.ts 里）
 * ============================================================================
 * 候选冻结件把 `m6.1-contract.ts` 当作**判定链路**文件逐字哈希。而验收语料**升一次版本**
 * 就要改一次版本常量与文件清单 —— 那本来只是**运行配置**的变动，却会让候选 id 跟着变。
 * 实测代价：语料 v1 → v2 时候选 id 无谓地从 `ae01ff0a8f04` 变成 `929536c770bc`，
 * 而判定规则一字未动。于是"id 变了"不再意味着"判定器变了"，
 * **冻结件的信号价值被削弱**——这正是本仓库反复登记的那类"字段存在、含义却不成立"。
 *
 * ⇒ 按工作单第 1 项与第 3 项的分工切开：
 * ```text
 *   候选（candidate）  = 判定规则本身           → m6.1-contract.ts / instrument.ts / …
 *   运行配置（run-config） = 读哪一套语料、跑哪些命令 → 本文件 + run-config-freeze.json
 * ```
 * 语料摘要由**运行配置冻结件**与**运行时自检**双重绑定（`readFrozenCorpus` 会核对
 * 正文摘要与清单一致），因此把版本常量搬到这里**不降低任何保护**。
 */

import { M6_1_CORPUS_VERSION } from './m6.1-contract.ts'

export const M6_1_ACCEPTANCE_VERSION = 'm6.1-acceptance@6'
/** 验收语料的版本号（整数部分）。文件名与版本号由它派生，防止两处走偏。 */
export const M6_1_ACCEPTANCE_REVISION = 6

export type CorpusName = 'legacy' | 'acceptance'

/**
 * 两套语料**各自**的文件清单。
 *
 * ⚠️ 刻意做成"两个独立的集合"而不是"往同一个池子里加文件"：
 * 工作单第 3 项明令新 heldout 不得与已用于开发的样本**混合后靠总分通过**。
 * 想混只有在代码里显式写出来 —— 不会因为某个循环顺手多读一个目录而发生。
 */
export const CORPUS_FILES: Record<CorpusName, readonly string[]> = {
  legacy: [
    'evals/m6.1/corpus/dev.jsonl',
    'evals/m6.1/corpus/calibration.jsonl',
    'evals/m6.1/corpus/heldout.jsonl',
  ],
  acceptance: [`evals/m6.1/acceptance/acceptance-v${String(M6_1_ACCEPTANCE_REVISION)}.jsonl`],
}

/** 验收语料的清单（含它自己的摘要），用于把读数**绑定**到某一版语料。 */
export const ACCEPTANCE_MANIFEST_PATH = 'evals/m6.1/acceptance/manifest.json'

/** 审核状态的取值（闭集）。 */
export const ACCEPTANCE_REVIEW_STATUSES = [
  'AWAITING_HUMAN_REVIEW',
  'REVIEW_COMPLETE_PENDING_SIGNOFF',
  'APPROVED',
] as const
export type AcceptanceReviewStatus = (typeof ACCEPTANCE_REVIEW_STATUSES)[number]

/**
 * 人工审核**签字之前不许跑**验收语料。
 *
 * 工作单第 2 项：「在人工审核和冻结前，不调用候选判定器试判这些样本」。
 * 这条纪律此前只靠"我记得不要跑"—— 那是**纪律**，不是**闸**。
 * 现在做成失败关闭：`--corpus acceptance` 在清单状态不是 `APPROVED` 时直接拒绝运行。
 *
 * ⚠️ 它挡的是"未签字就跑"，**不**代替签字本身：状态由人工审核记录决定，
 * 助手不得代填（清单里的 `reviewRecord.notYetRecorded` 就是要说清这一点）。
 */
export function assertAcceptanceApproved(reviewStatus: string): void {
  if ((ACCEPTANCE_REVIEW_STATUSES as readonly string[]).includes(reviewStatus) === false) {
    throw new Error(
      `验收语料清单里的 reviewStatus=${JSON.stringify(reviewStatus)} 不在闭集 ` +
        `${ACCEPTANCE_REVIEW_STATUSES.join(' / ')} 里 ⇒ 拒绝运行（状态不明等于没签字）`
    )
  }
  if (reviewStatus !== 'APPROVED') {
    throw new Error(
      `验收语料的审核状态是 ${reviewStatus}（尚未签字）⇒ 拒绝运行。` +
        '工作单第 2 项明令：人工审核与冻结之前不得用候选判定器试判这些样本。' +
        '签字确认后把清单状态置为 APPROVED 再跑。'
    )
  }
}

/** 解析 `--corpus` 的取值；未知取值 ⇒ 抛错（**不**回落到 legacy）。 */
export function parseCorpusName(value: string): CorpusName {
  if (value === 'legacy' || value === 'acceptance') return value
  throw new Error(`--corpus 只能是 legacy / acceptance（收到 ${JSON.stringify(value)}）`)
}

/**
 * 一轮读数要记下的**语料身份**（版本 + 文件清单）。
 *
 * ============================================================================
 *  为什么必须有这个函数（实测逼出来的）
 * ============================================================================
 * live 门里有两处都记"这一轮读的是哪套语料"：证据的 `scope` 块与运行时清单
 * (`manifest.json`)。第一版两处**各写各的** —— `scope` 用了三元判断、清单写死了
 * 旧语料版本 ⇒ 正式验收轮的清单写着 `m6.1-corpus@3`，而它实际读的是
 * `m6.1-acceptance@4`。只看清单的人会以为那轮用了旧语料。
 *
 * ⇒ 收成一个来源：两处都调这里，**结构上不可能分叉**。
 *    这类"同一个事实有两份手写副本"正是本仓库反复登记的缺陷来源。
 */
export function corpusIdentity(corpus: CorpusName): {
  readonly version: string
  readonly files: readonly string[]
} {
  return {
    version: corpus === 'acceptance' ? M6_1_ACCEPTANCE_VERSION : M6_1_CORPUS_VERSION,
    files: CORPUS_FILES[corpus],
  }
}

/** 验收语料的读数模式：**全量**（可出有效性判定），因此不许 `--limit` / `--only`。 */
export function assertCorpusRunMode(
  corpus: CorpusName,
  options: { readonly limit: number | null; readonly only: readonly string[] | null }
): void {
  if (corpus !== 'acceptance') return
  if (options.limit !== null || options.only !== null) {
    throw new Error(
      '验收语料（--corpus acceptance）**不接受** --limit / --only：' +
        '它的分母就是正式验收的分母，截取或点名会让判定失真。' +
        '要跑诊断档请显式用 --corpus legacy。'
    )
  }
}
