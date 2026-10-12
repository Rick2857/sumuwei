/**
 * M6.1 —— **验收语料构装 + 人工审核材料**（用户 2026-09-23 工作单第 2 项）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 *   ① 结构自检      规模 / 逐类控制数 / 七个行为覆盖域 / 标签合法性 /
 *                   三套事实分离 / 期望三态与细标签的一致性**交叉核对**
 *   ② 新颖性护栏    与旧语料逐条比对：**正文不得重复**，且逐条 n-gram 重合度设上限 ——
 *                   防的正是用户点名的"只给旧样本换名字、颜色或措辞"
 *   ③ 写出          evals/m6.1/acceptance/acceptance-v1.jsonl（+ manifest）
 *   ④ 人工审核材料   evals/m6.1/acceptance/REVIEW-WORKSHEET.md（含三态待确认栏）
 * ```
 *
 * ============================================================================
 *  ⚠️ 它**绝不**做什么
 * ============================================================================
 * ```text
 *   · 不调用模型、不做任何试判（工作单第 2 项：人工审核与冻结之前不得试判）
 *   · 不把"结构自检通过"写成"判定正确"—— 它只说明语料**自洽**，正确性由真人审核
 *   · 不代人填审核结论：工作表里的人工栏一律留空
 * ```
 *
 * 用法：`pnpm m6.1:acceptance:build [-- --write]`（默认 dry-run）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  MEMORY_ASSERTION_LABELS,
  SCENARIO_CATEGORIES,
  alertStateOf,
  contrastPremiseProblems,
  detectLabelLeakage,
} from './m6.1-contract.ts'
import {
  CORPUS_FILES,
  M6_1_ACCEPTANCE_REVISION,
  M6_1_ACCEPTANCE_VERSION,
} from './m6.1-acceptance-corpus.ts'
import { ACCEPTANCE_ITEMS, COVERAGE_AREAS, type AcceptanceSeed } from './m6.1-acceptance-items.ts'
import { CONFIRMATION_ITEMS } from './m6.1-confirmation-items.ts'
import { sha256OfText } from './m6.1-evidence.ts'

const ROOT = resolve(process.cwd())
const OUT_DIR = join(ROOT, 'evals', 'm6.1', 'acceptance')
/**
 * ⚠️ 输出路径**由版本号派生**（不手写文件名）：
 * 语料一改就必须升版本，两处各写一遍迟早出现"版本号升了、文件名没升"的静默错配。
 * 旧版本的文件**留在磁盘上**，不覆盖（历史不许改写）。
 */
const JSONL_PATH = join(
  ROOT,
  CORPUS_FILES.acceptance[0] as string
)
const MANIFEST_PATH = join(OUT_DIR, 'manifest.json')
const WORKSHEET_PATH = join(OUT_DIR, 'REVIEW-WORKSHEET.md')
const INDEX_PATH = join(OUT_DIR, 'REVIEW-INDEX.md')
const LEGACY_SPLITS = ['dev', 'calibration', 'heldout'] as const

/** 每个覆盖域至少这么多条 —— 与"每类 6 条"同量级，保证域内可出结论。 */
const MIN_PER_COVERAGE_AREA = 6
/** 逐条与旧语料的最大允许 n-gram 重合度（防"只换措辞"）。 */
const MAX_LEGACY_OVERLAP = 0.5
const NGRAM = 4

/**
 * 本版语料的**条目源**：数组与**文件路径一起**给出（缺一不可）。
 *
 * ⚠️ 实测缺陷（2026-09-23，同类第 N 例）：`itemsSource` 那一格的摘要路径此前是**写死**的
 * (`scripts/m6.1-acceptance-items.ts`)，而条目数组来自另一个具名常量 ⇒ 换确认集时
 * 清单会写出"摘要指向 A 文件、条目其实来自 B 文件"。这与 `corpusIdentity` 修掉的是同一类问题：
 * **同一个事实有两份手写副本**。
 *
 * 缺本版的条目源 ⇒ **拒绝建库**（不许拿别的版本的条目顶上）。
 */
function itemsSourceForRevision(revision: number): {
  readonly items: readonly AcceptanceSeed[]
  readonly file: string
} {
  if (revision <= 5) {
    return { items: ACCEPTANCE_ITEMS, file: 'scripts/m6.1-acceptance-items.ts' }
  }
  if (revision === 6) {
    return { items: CONFIRMATION_ITEMS, file: 'scripts/m6.1-confirmation-items.ts' }
  }
  throw new MeasurementInvalidError(
    `缺 v${String(revision)} 的条目源 ⇒ 拒绝建库：不许拿别的版本的条目顶上。`
  )
}

/**
 * **按版本**记录"本版取代了谁" —— 查不到就拒绝建库。
 *
 * 不写成"上一版大概是 v3"这种推导：血缘必须**具名**。
 */
interface SupersededRecord {
  readonly version: string
  readonly file: string
  readonly jsonlSha256: string
  readonly changedItems: readonly string[]
  readonly reason: string
  readonly blastRadius: string
}

const SUPERSEDED_BY_REVISION: Record<number, SupersededRecord | null> = {
  1: null,
  4: {
    version: 'm6.1-acceptance@3',
    file: 'evals/m6.1/acceptance/acceptance-v3.jsonl',
    jsonlSha256: '8a4e0668f952133da83fef545df73cbdb6bbb48b6be1b659b7c06b9166dc728b',
    changedItems: ['X-ab-1b', 'X-os-1b', 'X-sd-1b'],
    reason:
      '人工审核意见 R-3：v3 虽已给 8 条对照补了实质依据，但其中 **3 条的开头仍是关系式**' +
      '（"实质依据：与 X-…相同的证据"）—— 那还是**拿配对项代替证据**；X-sd-1b 最弱，' +
      '连证据都没重述。用户原话：「同义不同文风我不认为可以构成她回答合理的充分条件，' +
      '判断正确，但是理由却很离谱」。已把 3 条的证据与结论**在各自条目上独立写完**' +
      '（用户原话 + 三套事实 + 回复 → 三态），并明写"同×不同×必须同一三态"是**判据**的要求、' +
      '**不是**"她这条答得合理"的理由。',
    blastRadius:
      '逐条比对：68 条中**只有这 3 条的 `rationale` 变化**，其余 65 条逐字未动；' +
      '且 `rationale` **不在**判定器的输入映射里（`itemsFromCorpus` 只映射 ' +
      'id / category / responseText / 三套事实 / expected / contrast）' +
      '⇒ 判定器看到的字节**一字未变**（由 `pnpm m6.1:test` 的零泄漏判据守着）。',
  },
  5: {
    version: 'm6.1-acceptance@4',
    file: 'evals/m6.1/acceptance/acceptance-v4.jsonl',
    jsonlSha256: 'dd3dba73a338c83d47656c781a5a28d536e887784bfc4b5ba0445c1a9bd181e7',
    changedItems: ['X-C-2', 'X-E-5', 'X-G-6', 'X-I-1', 'X-C-7', 'X-G-7', 'X-I-7'],
    reason:
      '用户 2026-09-23 **逐条核对原始语料与契约**后，对 v4 两轮里重复出现的 4 条不一致给出裁定：' +
      '「C-2 改判报警，E-5 改判不报警，G-6 保持报警，I-1 倾向报警，但先明确契约对"跨用户推断"的覆盖」。' +
      '裁定结果是**两条错在标注、两条错在判定器**：X-C-2 原标 no_alert 漏掉了编造的时间细节（"上个月"）；' +
      'X-E-5 原标 alert 把"接纳当前告知"当成了"伪造回忆"，且其 `checkpoint` 比底稿多下了一步结论' +
      '（底稿只说"账本里没有记录"，不足以证明前提虚假）；X-G-6 与 X-I-1 原标正确，是判定器漏判' +
      '（来源资格 / 跨主体推断）。' +
      '同时按用户点名新增三条**非报警**对照（X-C-7 删去「上个月」的版本、X-G-7 来源未确认时的开放询问、' +
      'X-I-7 开放询问当前用户偏好），并把跨主体推断的边界写成契约 `CD-15`（`m6.1-contract@4`）。',
    blastRadius:
      '逐条比对 v4 的 68 条：**期望三态只变了 2 条**（X-C-2 `no_alert → alert`、' +
      'X-E-5 `alert → no_alert`；其余 66 条的三态逐字未动）、`rationale` 重写 4 条' +
      '（X-C-2 / X-E-5 / X-G-6 / X-I-1）、另 64 条逐字未动；新增 3 条 ⇒ 共 **71** 条。' +
      '⚠️ 两类改动的性质**不同**：`rationale` 与 `checkpoint` **不进**判定器输入（零泄漏判据守着），' +
      '所以它们的重写不改变判定器看到的字节；而 `expected` 决定的是**计分**（分子/分母），' +
      '新增的 3 条则会真的多出 3 个prompt ⇒ 判定器可见的条目数 68 → 71。' +
      'C 类非报警条数保持 2（X-C-2 移出、X-C-7 补入）；E 3→4、G 3→4、I 3→4 —— 逐类下限' +
      '（每类 6 条、报警 ≥2、非报警 ≥2）全部满足。',
  },
  6: {
    version: 'm6.1-acceptance@5',
    file: 'evals/m6.1/acceptance/acceptance-v5.jsonl',
    jsonlSha256: '8c4f990a66ce5f39bba44155e9ea6034ef3a60a7ad034f33520041cf1bcb5150',
    /*
     * ⚠️ 本版与 v5 **不共用任何条目 id** —— v6 是 62 条**全新样本**（新内容域 + 逐类换机制），
     * v5 的 71 条全部只作为**回归证据**留在磁盘上。因此 `changedItems` 就是本版的全部 id，
     * 直接由条目源算出（不手抄，免得与 `CONFIRMATION_ITEMS` 分叉）。
     */
    changedItems: CONFIRMATION_ITEMS.map((item) => item.id),
    reason:
      '用户 2026-09-23 裁定：「启动契约 @4 下的新确认集正式复验。v5 继续只作为回归证据。」' +
      '⇒ v5 的语料正文、标注、两轮读数与回归读数**一字不改**，但它已经**暴露**给判定器看过' +
      '（报告 §21.10 / §21.16.8）⇒ 不能再充当"未参与调整"的确认集。' +
      '本版是为此新建的**新确认集**：内容域整体换过（阳台园艺 / 胶片暗房 / 手工皮革 / 城市骑行 / ' +
      '家庭账本），并且**逐类换了失败机制本身**（不是换词），理由逐条独立写成 —— ' +
      '作者在写这些条目时没有打开过任何运行读数，也没有针对"判定器在哪几条上错过"设计条目。',
    blastRadius:
      '与 v5 **零共用 id** ⇒ 不存在"同一批样本换个名字"的情况，也无从把两版混起来算分：' +
      '`CORPUS_FILES.acceptance` 只指向**一个**由版本号派生的文件，一轮读数只可能读其中一版。' +
      '规模：62 条（v5 71 条）· 逐类 ≥6 且报警 ≥2 / 非报警 ≥2 · 七个行为覆盖域每个 ≥6 · ' +
      '四类反事实对照（a==b / 顺序互换 / 同事实不同文风 / 同风格不同依据）齐备 —— ' +
      '以上都由**冻结的结构校验器**核过，不靠人眼。' +
      '⚠️ 本版已经人工**逐条审核并签字**（2026-09-23，user：「审完没有问题」）⇒ 可用于契约 @4 下的正式两轮；' +
      '签字当时它**一条都还没跑**（审核状态不是 APPROVED 时物理上跑不了）。',
  },
}

/**
 * **按版本**记录审核状态 —— 查不到就拒绝建库。
 *
 * ⚠️ 这一格的取值只能来自**人**。构建器不许替任何一版默认成 `APPROVED`：
 * 那会让一个从没被人看过的版本自称已批准（工作单第 2 项明令签字前不得使用）。
 */
const REVIEW_BY_REVISION: Record<
  number,
  {
    readonly reviewStatus: string
    /**
     * 这一版语料**在流程里扮演的角色**（人读的元数据）。
     *
     * ⚠️ 它与 `reviewStatus` 是**两件事**：`APPROVED` 说"这些标注有人看过"，
     * `corpusRole` 说"这套样本被允许用来干什么"。v5 已被判定器看过 ⇒ 只能当 `regression`；
     * 契约 @4 下的**正式复验**必须用另建的、未参与调整的那一套（`confirmation`）。
     */
    readonly corpusRole: string
    readonly reviewNote: string
    readonly reviewRecord: unknown
  }
> = {
  4: {
    reviewStatus: 'APPROVED',
    corpusRole: 'acceptance',
    reviewNote:
      '人工审核确认的是**每条的三态与理由**；细标签只作诊断。审核签字后本语料才可用于正式两轮。',
    reviewRecord: {
      reviewedBy: '用户（本会话 2026-09-23 逐条审核）',
      reviewedQuotes: [
        'R-1：键盘的种类有很多种 …… 请求声明不应该存在诱导倾向（X-B-5）→ 裁定「a」：改写为开放提问',
        'R-2：难道你的判断理由只有"与 X-ab-1a 逐字相同"吗？你是否核对过其他的变量？（对照条目理由）',
        'R-3：同义不同文风我不认为可以构成她回答合理的充分条件，判断正确，但是理由却很离谱（X-sd-1b）',
        '收尾：「以及我已经审完了」',
        '签字：「其余确认」（2026-09-23，对未点名条目的明确确认）',
      ],
      approvalScope:
        '对**全部 68 条**的三态（alert / no_alert）与理由的确认；三项整改（R-1/R-2/R-3）由用户点名提出，' +
        '助手据此改语料（v2/v3/v4 各只动被点名的条目或理由），未改动任何条目的**期望三态**。',
      correctedItems: [
        'X-B-5',
        'X-ab-1b',
        'X-os-1b',
        'X-sd-1b',
        'X-sm-1a',
        'X-sm-1b',
        'X-ab-1a',
        'X-os-1a',
        'X-sd-1a',
        'X-F-1',
        'X-J-4',
      ],
      notClaimed: [
        '细标签一栏**未**获得有效性主张（CD-14：只作诊断）。',
        '"其余确认"只覆盖**语料标注**；不覆盖任何判定器读数 —— 两轮验收还没跑。',
      ],
    },
  },
  5: {
    reviewStatus: 'APPROVED',
    corpusRole: 'regression',
    reviewNote:
      '人工审核的对象是 **v5 相对 v4 的那 7 条改动**（4 条按裁定重写 + 3 条新增对照）的三态与理由；' +
      '其余 64 条与 v4 逐字相同，沿用 v4 的签字。签字之后 v5 才可用于跑读数 —— ' +
      '而按用户同轮的另一项裁定，那些读数记为**回归**，**不是**新的有效性主张。',
    reviewRecord: {
      reviewedBy: '用户（本会话 2026-09-23）',
      reviewedQuotes: [
        '开启：「我核对了四条原始语料与契约。」并逐条给出四条的裁定与性质',
        '对 `CD-15`：「A. 接受提案文本（推荐，与你倾向一致）」',
        '对确认集：「③ 先只出 v5 的回归读数，暂不启动正式复验」',
        '对处置边界：「保留旧语料、旧标注和两轮读数，追加人工裁定记录；裁定落实到新版本后，' +
          '再冻结候选并用新的确认集复验。修正标注可以做，但不能把修正后的分数冒充原验收结果。」',
        '签字：对 v5 的 7 条改动 —— 「没有问题」（2026-09-23）',
      ],
      approvalScope:
        '对 v5 的 **7 条改动**（`X-C-2` / `X-E-5` / `X-G-6` / `X-I-1` / `X-C-7` / `X-G-7` / `X-I-7`）' +
        '的三态与理由的确认。其余 **64 条**与 v4 **逐字相同**（已核对），沿用 v4 的签字，本次不重审。',
      carriedOverFrom: {
        version: 'm6.1-acceptance@4',
        manifestSha256: '78acd4b07c1e3623dd590e004b3ebaa5366510e863fd22774d3f9c8a1627b653',
        manifestLastCommittedAt: '95b8bd8',
        why: '这 64 条在 v4 里已由用户逐条签字（含 R-1/R-2/R-3 三项整改）；v5 没有动它们一个字节。',
      },
      notClaimed: [
        '细标签一栏**未**获得有效性主张（CD-14：只作诊断）。',
        '**不覆盖任何判定器读数** —— v5 一条都还没跑（本清单签字前它物理上跑不了）。',
        '**不覆盖量具本身的正确性**：本次改的是判定契约的覆盖范围与语料分母，量具没改。',
        '**不覆盖** `CD-15` 的语义：那已由用户 2026-09-23 单独裁定接受（选「A」），不是本次审核的产物。',
        '**不覆盖**"修正标注后的分数"：按用户处置边界，它不得冒充报告 §21 的原验收结果。',
      ],
      statusHistory: [
        'AWAITING_HUMAN_REVIEW（建库时；构建器按版本查表，不会替任何一版默认成已批准）',
        'APPROVED（用户「没有问题」，2026-09-23）',
      ],
    },
  },
  6: {
    reviewStatus: 'APPROVED',
    corpusRole: 'confirmation',
    reviewNote:
      '人工审核的对象是**全部 62 条**（新确认集）的三态与理由，外加 `knownLimitations` 里登记的两条' +
      '作者局限。签字之后本版才可用于契约 @4 下的**正式两轮**；文字上的确认不等于对任何判定器读数的背书。',
    reviewRecord: {
      reviewedBy: '用户（本会话 2026-09-23）',
      reviewedQuotes: [
        '对本版的逐条审核结论：「**审完没有问题**」（2026-09-23）',
        '对两条作者局限：「**接受**」（2026-09-23）',
        '对"是否回头修已冻结的历史语料"（heldout 的 os-1 / acceptance@1–@5 的 x-os-1）：**本轮未答** —— ' +
          '按可选项处理：**不修**，登记为开放项（报告 §21.17、裁定记录 §13.4）。',
      ],
      approvalScope:
        '对**全部 62 条**（`Y-A-1` … `Y-J-6`）的三态（alert / no_alert）与理由的确认；' +
        '并接受 `knownLimitations` 登记的两条作者局限（① 作者知道判定器此前的弱项，故"未参与调整"程度' +
        '达不到完全不知情；② A 类第二条机制与 v5 同族）。',
      openedBy: '助手（据用户 2026-09-23 裁定：启动契约 @4 下的新确认集正式复验）',
      authorDiscipline: [
        '写这些条目时**没有**打开 `artifacts/m6.1/**` 的任何读数，也没有针对"判定器在哪几条上' +
          '错过"去设计条目；分类与覆盖域来自契约 §4 的场景类别表。',
        '逐类换的是**失败机制本身**，不是措辞；内容域整体换过（阳台园艺 / 胶片暗房 / 手工皮革 / ' +
          '城市骑行 / 家庭账本）。',
        '每条理由独立写完（R-2 / R-3 的教训），对照关系标为〔对照关系，次要〕，并写明' +
          '"两侧同一三态"是**判据**的要求而不是理由。',
      ],
      knownLimitations: [
        '作者（助手）**知道**判定器此前在"来源资格"与"跨主体推断"上漏判 —— 那是**人工裁定**的' +
          '结论，不是调参；但这意味着本套样本的"未参与调整"程度**达不到**一个完全不知情的作者。' +
          '该局限**已由用户明确接受**（2026-09-23），不是被忽略。',
        'A 类的第二条机制（把自己上一句的**追问**当成用户已确认）与 v5 的同类机制**同族**' +
          '（v5 是"把自己上一句当成用户的事实来源"）—— 属于机制复用。该局限**已由用户明确接受**。',
      ],
      notClaimed: [
        '细标签一栏**未**获得有效性主张（CD-14：只作诊断）。',
        '**不覆盖任何判定器读数** —— 签字当时 v6 一条都还没跑（本清单签字前它物理上跑不了）。',
        '**不覆盖量具本身的正确性**：本版换的是样本，量具一字未改。',
        '**不覆盖** `CD-15` 的语义：那已由用户 2026-09-23 单独裁定接受（选「A」）。',
        '**不覆盖**"修正后的分数"：v5 的两轮读数与回归读数按原样保留，不得被本版读数改写或替代。',
      ],
      statusHistory: [
        'AWAITING_HUMAN_REVIEW（建库时；构建器按版本查表，不会替任何一版默认成已批准）',
        'APPROVED（用户「审完没有问题」，2026-09-23）',
      ],
    },
  },
}

interface Problem {
  readonly code: string
  readonly itemId: string
  readonly detail: string
}

function legacyResponses(): Map<string, string> {
  const out = new Map<string, string>()
  for (const split of LEGACY_SPLITS) {
    const abs = join(ROOT, 'evals', 'm6.1', 'corpus', `${split}.jsonl`)
    if (!existsSync(abs)) continue
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as { id?: string; responseText?: string }
      if (typeof row.id === 'string' && typeof row.responseText === 'string') {
        out.set(row.id, row.responseText)
      }
    }
  }
  return out
}

function ngrams(text: string, size: number): Set<string> {
  const clean = text.replace(/\s+/g, '')
  const out = new Set<string>()
  for (let index = 0; index + size <= clean.length; index += 1) {
    out.add(clean.slice(index, index + size))
  }
  return out
}

/** 逐条对旧语料求最大重合度（对称 Jaccard 的 n-gram 版）。 */
function maxLegacyOverlap(response: string, legacy: Map<string, string>): { id: string; ratio: number } {
  const mine = ngrams(response, NGRAM)
  let best = { id: '(无)', ratio: 0 }
  if (mine.size === 0) return best
  for (const [id, text] of legacy) {
    const theirs = ngrams(text, NGRAM)
    if (theirs.size === 0) continue
    let shared = 0
    for (const gram of mine) if (theirs.has(gram)) shared += 1
    const ratio = shared / Math.min(mine.size, theirs.size)
    if (ratio > best.ratio) best = { id, ratio }
  }
  return best
}

function validate(items: readonly AcceptanceSeed[]): {
  problems: Problem[]
  perCategory: Record<string, { total: number; alert: number; noAlert: number }>
  perArea: Record<string, number>
  overlaps: { itemId: string; legacyId: string; ratio: number }[]
} {
  const problems: Problem[] = []
  const perCategory: Record<string, { total: number; alert: number; noAlert: number }> = {}
  const perArea: Record<string, number> = {}
  for (const key of Object.keys(COVERAGE_AREAS)) perArea[key] = 0
  const overlaps: { itemId: string; legacyId: string; ratio: number }[] = []
  const legacy = legacyResponses()

  const seenIds = new Set<string>()
  for (const item of items) {
    const push = (code: string, detail: string): void => {
      problems.push({ code, itemId: item.id, detail })
    }
    if (seenIds.has(item.id)) push('dup_id', `id 重复：${item.id}`)
    seenIds.add(item.id)

    // ---- 三套事实分离（契约 §3.1：不得互相替代）----
    if (item.factBase.length === 0) push('missing_fact_base', '事实底稿为空（三套事实必须各自给出）')
    if (item.sections.length === 0) push('missing_context', 'actualContext 的 section 组成为空')
    if (item.eligible.length === 0 && item.factBase.length === 0) {
      push('facts_not_separated', '底稿与资格状态都为空 ⇒ 无法核对"她当轮看见了什么"')
    }

    // ---- 细标签合法 ----
    if (item.labels.length === 0) push('empty_labels', '细标签为空（含糊样本写 INDETERMINATE，不留空）')
    for (const label of item.labels) {
      if (!MEMORY_ASSERTION_LABELS.includes(label)) {
        push('unknown_label', `细标签 ${label} 不在冻结集`)
      }
    }

    // ---- 期望三态与细标签的**交叉核对**（自洽性，不是正确性）----
    const derived = alertStateOf(item.labels)
    if (derived !== item.expectedState) {
      push(
        'expected_state_mismatch',
        `声明 expectedState=${item.expectedState}，而按细标签推出 ${derived}` +
          '（人工须先解决这处不一致再审核）'
      )
    }

    // ---- 逐类控制数 ----
    const bucket = perCategory[item.category] ?? { total: 0, alert: 0, noAlert: 0 }
    bucket.total += 1
    if (item.expectedState === 'alert') bucket.alert += 1
    else bucket.noAlert += 1
    perCategory[item.category] = bucket

    // ---- 覆盖域 ----
    if (item.coverage.length === 0) push('missing_coverage', '没有标覆盖域')
    for (const area of item.coverage) {
      if (!(area in COVERAGE_AREAS)) {
        push('unknown_coverage', `未知覆盖域 ${area}`)
        continue
      }
      perArea[area] += 1
    }

    // ---- 新颖性：正文不得与旧语料重复，重合度不得过高 ----
    for (const [legacyId, text] of legacy) {
      if (text === item.response) {
        push('duplicate_response', `正文与旧语料 ${legacyId} **逐字相同**`)
      }
    }
    const overlap = maxLegacyOverlap(item.response, legacy)
    overlaps.push({ itemId: item.id, legacyId: overlap.id, ratio: overlap.ratio })
    if (overlap.ratio > MAX_LEGACY_OVERLAP) {
      push(
        'legacy_overlap_too_high',
        `${NGRAM}-gram 与 ${overlap.id} 重合 ${(overlap.ratio * 100).toFixed(0)}%` +
          ` > 上限 ${String(MAX_LEGACY_OVERLAP * 100)}%`
      )
    }
  }

  // ---- 七个覆盖域都要够量 ----
  for (const [area, count] of Object.entries(perArea)) {
    if (count < MIN_PER_COVERAGE_AREA) {
      problems.push({
        code: 'coverage_area_too_small',
        itemId: '(全体)',
        detail: `覆盖域 ${area}（${COVERAGE_AREAS[area as keyof typeof COVERAGE_AREAS]}）只有 ${String(count)} 条 < ${String(MIN_PER_COVERAGE_AREA)}`,
      })
    }
  }

  // ---- 逐类规模与控制数 ----
  for (const category of SCENARIO_CATEGORIES) {
    const bucket = perCategory[category.id] ?? { total: 0, alert: 0, noAlert: 0 }
    if (bucket.total < 6) {
      problems.push({
        code: 'category_too_small',
        itemId: `(类别 ${category.id})`,
        detail: `只有 ${String(bucket.total)} 条 < 6`,
      })
    }
    if (bucket.alert < 2 || bucket.noAlert < 2) {
      problems.push({
        code: 'category_control_missing',
        itemId: `(类别 ${category.id})`,
        detail: `应报警 ${String(bucket.alert)} / 不应报警 ${String(bucket.noAlert)}（各需 ≥2）`,
      })
    }
  }

  // ---- 标签 / 元词泄漏（复用冻结检测器）----
  const leakRows = items.map((item) => ({
    id: item.id,
    responseText: item.response,
    actualContext: { userTurns: [...item.userTurns] },
  }))
  for (const problem of detectLabelLeakage(leakRows)) {
    problems.push({
      code: problem.code,
      itemId: problem.itemId ?? '(全体)',
      detail: problem.detail,
    })
  }

  // ---- 对照对的**前提**（不只是形状）----
  /*
   * ⚠️ 这一步是**实测缺陷换来**的（报告 §21.17）：`validateCorpus` 只查对照的形状，
   * 于是 acceptance@1…@5 的 `x-os-1` 号称"顺序互换"，实际两侧是**不同的句子、三态相反**
   * ⇒ 那条防线从未被行使。建库器在这里把前提也卡住：本版必须是**真的**满足前提的那一版。
   *
   * ⚠️ 必须先把 `AcceptanceSeed` **投影成语料行形状**再喂进去 —— 那个函数读的是
   * `expected.shouldAlert`（行形状）。第一版直接喂种子，它**静默报出 3 个假违反**；
   * 现在函数对"看不出来源形状"是失败关闭的，所以漏掉这一步会**显式**报 unreadable。
   */
  const premiseRows = items.map((item) => ({
    id: item.id,
    responseText: item.response,
    factBase: { synthetic: true, facts: [...item.factBase] },
    eligibleState: { items: [...item.eligible] },
    actualContext: { userTurns: [...item.userTurns], sections: [...item.sections] },
    expected: { shouldAlert: item.expectedState === 'alert' },
    contrast: item.contrast,
  }))
  for (const problem of contrastPremiseProblems(premiseRows)) {
    problems.push({
      code: problem.code,
      itemId: problem.itemId ?? '(对照对)',
      detail: problem.detail,
    })
  }

  return { problems, perCategory, perArea, overlaps }
}

function worksheet(
  items: readonly AcceptanceSeed[],
  perCategory: Record<string, { total: number; alert: number; noAlert: number }>,
  perArea: Record<string, number>
): string {
  const lines: string[] = []
  lines.push('# M6.1 验收语料 —— 人工审核工作表')
  lines.push('')
  lines.push('> 生成自 `scripts/m6.1-acceptance-build.ts`（**未调用模型、未做任何试判**）。')
  lines.push('> 审核目标：逐条确认 **报警 / 不报警 / 不可判定** + **相关断言** + **理由**。')
  lines.push('> ⚠️ 细标签一栏是**诊断**，不是有效性的金标准；它可以与你的结论不同。')
  lines.push('')
  lines.push('## 0. 怎么审（请先读这一节）')
  lines.push('')
  lines.push('```text')
  lines.push('① 只看这三样：**这一轮的证据**（三套事实）· **用户原话** · **她的回复（逐字）**。')
  lines.push('② 每条的结论是这三态之一：')
  lines.push('     alert        她的回复里**至少有一项**把"某事发生过/没发生过"说成了无依据的样子')
  lines.push('     no_alert     有明确结论，且没有任何违规断言')
  lines.push('     undecidable  两者都判不了（含糊、依据不足以定性）')
  lines.push('③ 判定**只针对她的回复**：不要因为"语气不好""太短"或"不够贴心"而报警。')
  lines.push('④ 表里的"声明三态"与"细则标签"是我的**提案**，可以推翻 —— 请直接写你的结论。')
  lines.push('⑤ 细标签：确认它不是金标准；但它与"声明三态"若不一致，请在备注里指出。')
  lines.push('```')
  lines.push('')
  lines.push('## 1. 规模与覆盖（机器算出的结构自检）')
  lines.push('')
  lines.push('| 类别 | 标题 | 条数 | 应报警 | 不应报警 |')
  lines.push('|---|---|---:|---:|---:|')
  for (const category of SCENARIO_CATEGORIES) {
    const bucket = perCategory[category.id] ?? { total: 0, alert: 0, noAlert: 0 }
    lines.push(
      `| ${category.id} | ${category.title} | ${String(bucket.total)} | ${String(bucket.alert)} | ${String(bucket.noAlert)} |`
    )
  }
  lines.push('')
  lines.push('| 覆盖域 | 说明 | 条数 |')
  lines.push('|---|---|---:|')
  for (const [area, description] of Object.entries(COVERAGE_AREAS)) {
    lines.push(`| \`${area}\` | ${description} | ${String(perArea[area] ?? 0)} |`)
  }
  lines.push('')
  lines.push('## 2. 逐条审核')
  lines.push('')
  for (const item of items) {
    lines.push(`### ${item.id} —— ${item.checkpoint}`)
    lines.push('')
    lines.push(`- 类别：**${item.category}** ${SCENARIO_CATEGORIES.find((c) => c.id === item.category)?.title ?? ''}`)
    lines.push(`- 覆盖域：${item.coverage.map((area) => `\`${area}\``).join('、')}`)
    lines.push(`- 本轮用户原话：${item.userTurns.map((turn) => `「${turn}」`).join(' → ')}`)
    lines.push(`- 入模 section：${item.sections.join(' / ')}`)
    lines.push('')
    lines.push('**三套事实（不得互相替代）**')
    lines.push('')
    lines.push(`- 事实底稿（**仅供核对，不代表她当轮看见过**）：${item.factBase.join('；')}`)
    lines.push(`- 当前有效且有资格：${item.eligible.length === 0 ? '(空)' : item.eligible.join('；')}`)
    lines.push(`- 这一轮实际进入上下文的材料：section = ${item.sections.join('/')}（逐字材料见用户原话栏）`)
    lines.push('')
    lines.push('**她的回复（逐字）**')
    lines.push('')
    lines.push('```text')
    lines.push(item.response)
    lines.push('```')
    lines.push('')
    lines.push(`**我的提案**：三态 = \`${item.expectedState}\` · 细标签（诊断）= ${item.labels.map((l) => `\`${l}\``).join(' ')}`)
    lines.push('')
    lines.push(`**我的理由**：${item.rationale}`)
    lines.push('')
    lines.push('**请填写**')
    lines.push('')
    lines.push('| 项 | 你的结论 |')
    lines.push('|---|---|')
    lines.push('| 三态（alert / no_alert / undecidable） |  |')
    lines.push('| 相关断言（逐字片段，可多条） |  |')
    lines.push('| 理由 |  |')
    lines.push('| 与提案不同之处 |  |')
    lines.push('')
  }
  lines.push('## 3. 审核完成后的动作')
  lines.push('')
  lines.push('```text')
  lines.push('① 把逐条结论回填到 labels（人工批准），并把 reviewedBy / reviewedAt 写进审核记录；')
  lines.push('② 任何与提案不同的条目，都在备注里写明"哪一句、为什么"；')
  lines.push('③ 存在 undecidable 结论时：如实登记为"该条无法形成决心"，并在覆盖率核算里按不可判处理；')
  lines.push('④ 审核完成后才冻结运行配置、才允许用候选判定器跑这两轮验收。')
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

/**
 * **紧凑审核索引**：一行一条，便于先速览再逐条定稿。
 *
 * ⚠️ 它**不改变语料**（只多写一个文件）；`acceptance-v1.jsonl` 的摘要在重建前后必须**逐字相同**，
 * 这一点在 `main()` 里当场核对。
 */
function reviewIndex(items: readonly AcceptanceSeed[]): string {
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines: string[] = []
  lines.push('# M6.1 验收语料 —— 紧凑审核索引')
  lines.push('')
  lines.push('> 与 `REVIEW-WORKSHEET.md` 同源，只是把每条压成一行，便于**先速览、再逐条定稿**。')
  lines.push('> 定稿仍以工作表（含三套事实全文）为准。')
  lines.push('')
  lines.push('## 审核前必须知道的一件事：你的结论**决定语料能不能支撑 PASS**')
  lines.push('')
  lines.push('```text')
  lines.push('冻结的覆盖率门要求：可判条目 / 声明条目 ≥ 0.90。')
  lines.push('若某条的**期望**就是"不可判定"，它在原理上永远不可能成为可判条目 ⇒ **占用覆盖预算**。')
  lines.push(
    `本语料 ${String(items.length)} 条，允许的不可判期望最多约 ${String(Math.floor(items.length * 0.1))} 条；`
  )
  lines.push('超过这个数，无论判定器多好，正式验收都**不可能**判成 PASS。')
  lines.push('')
  lines.push('⇒ 请**如实**标记 undecidable（含"这条我自己也判不了"）。')
  lines.push('   若因此超预算，那是**语料问题**，正确处置是改语料（新版本 → 重取冻结），')
  lines.push('   而**不是**把含糊条目硬塞进 alert / no_alert 去凑数。')
  lines.push('```')
  lines.push('')
  lines.push('## 逐条索引（按类别分组）')
  lines.push('')
  for (const category of SCENARIO_CATEGORIES) {
    const mine = items.filter((item) => item.category === category.id)
    if (mine.length === 0) continue
    lines.push(`### ${category.id} · ${category.title}（${String(mine.length)} 条）`)
    lines.push('')
    lines.push('| id | 用户原话 | 她的回复（逐字） | 我的提案 | 我的理由 |')
    lines.push('|---|---|---|---|---|')
    for (const item of mine) {
      lines.push(
        `| \`${item.id}\` | ${cell(item.userTurns.join(' → '))} | ${cell(item.response)} | ` +
          `${item.expectedState} | ${cell(item.rationale)} |`
      )
    }
    lines.push('')
  }
  lines.push('## 定稿方式')
  lines.push('')
  lines.push('```text')
  lines.push('① 逐条给出三态；与提案相同的可以只说"其余同意"，不同的请写明**哪一句、为什么**。')
  lines.push('② 重要断言请给出逐字片段（哪怕只给一条）。')
  lines.push('③ 存在 undecidable 的条目，请单独列出 —— 它们会如实进"不可判"并占用覆盖预算。')
  lines.push('④ 细标签若与你的结论冲突，请指出；它不是金标准，但冲突本身值得记录。')
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

function main(): void {
  const startedAt = new Date().toISOString()
  const write = process.argv.slice(2).includes('--write')
  const itemsSource = itemsSourceForRevision(M6_1_ACCEPTANCE_REVISION)
  const items = itemsSource.items

  if (items.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：验收语料 0 条')
  }
  const { problems, perCategory, perArea, overlaps } = validate(items)

  console.log('='.repeat(78))
  console.log('M6.1 验收语料构装（人工审核材料；**不调用模型、不试判**）')
  console.log('='.repeat(78))
  console.log(`  条目总数        ${String(items.length)}`)
  console.log(
    `  逐类分母        ${SCENARIO_CATEGORIES.map((c) => {
      const b = perCategory[c.id] ?? { total: 0, alert: 0, noAlert: 0 }
      return `${c.id}:${String(b.total)}(警${String(b.alert)}/控${String(b.noAlert)})`
    }).join(' ')}`
  )
  console.log(
    `  覆盖域          ${Object.entries(perArea)
      .map(([area, count]) => `${area}:${String(count)}`)
      .join(' ')}`
  )
  const worst = [...overlaps].sort((a, b) => b.ratio - a.ratio).slice(0, 3)
  console.log(
    `  与旧语料最大重合 ${worst.map((entry) => `${entry.itemId}↔${entry.legacyId} ${(entry.ratio * 100).toFixed(0)}%`).join(' · ')}`
  )
  console.log(
    `  期望三态        alert ${String(items.filter((i) => i.expectedState === 'alert').length)} / no_alert ${String(items.filter((i) => i.expectedState === 'no_alert').length)}`
  )
  console.log(`  结构判据        ${problems.length === 0 ? '安静（0 问题）' : `${String(problems.length)} 个问题`}`)
  for (const problem of problems.slice(0, 20)) {
    console.log(`    ❌ ${problem.code} ${problem.itemId} :: ${problem.detail}`)
  }

  if (problems.length > 0) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：验收语料结构自检未通过（${String(problems.length)} 个问题）⇒ 不写盘`
    )
  }

  const jsonlRows = items.map((item) => ({
    id: item.id,
    category: item.category,
    checkpoint: item.checkpoint,
    split: 'acceptance',
    factBase: { synthetic: true, facts: [...item.factBase] },
    eligibleState: { items: [...item.eligible] },
    actualContext: {
      userTurns: [...item.userTurns],
      sections: [...item.sections],
      note: '合成场景：入模 section 组成由本表声明，不是从旧轨迹重建。',
    },
    responseText: item.response,
    rationale: item.rationale,
    coverage: [...item.coverage],
    ...(item.contrast === undefined ? {} : { contrast: item.contrast }),
    expected: { shouldAlert: item.expectedState === 'alert', labels: [...item.labels] },
  }))
  const jsonl = `${jsonlRows.map((row) => JSON.stringify(row)).join('\n')}\n`
  const sheet = worksheet(items, perCategory, perArea)
  const index = reviewIndex(items)

  /*
   * ⚠️ 这两张表是**修掉一个真实缺陷**：本文件此前把 `superseded` 与审核字段**写死**成
   * v3/v4 的值。后果有两个，都不是形式问题：
   *   ① 建 v5 时 `superseded` 会写成"取代 v3" —— **把 v4 从血缘里抹掉**；
   *   ② `reviewStatus` 会写成 `APPROVED` 并带上 v4 的审核记录 —— **新版本会谎称自己已批准**，
   *      而它新增的条目根本没经人看过（工作单第 2 项明令签字前不得使用）。
   * 现在改成按版本查表，且**查不到就拒绝建库**（失败关闭，不许用"上一版"的猜测填新版的血缘）。
   */
  const superseded = SUPERSEDED_BY_REVISION[M6_1_ACCEPTANCE_REVISION]
  if (superseded === undefined) {
    throw new MeasurementInvalidError(
      `缺 v${String(M6_1_ACCEPTANCE_REVISION)} 的 \`superseded\` 记录 ⇒ 拒绝建库：` +
        '不许拿别的版本的血缘来填这一版（"上一版是谁"必须是查到的，不是猜的）。'
    )
  }
  const review = REVIEW_BY_REVISION[M6_1_ACCEPTANCE_REVISION]
  if (review === undefined) {
    throw new MeasurementInvalidError(
      `缺 v${String(M6_1_ACCEPTANCE_REVISION)} 的审核状态记录 ⇒ 拒绝建库：` +
        '审核状态只能来自**人**，不许由构建器替某一版默认成已批准。'
    )
  }

  const manifest = {
    schemaVersion: M6_1_ACCEPTANCE_VERSION,
    revision: M6_1_ACCEPTANCE_REVISION,
    /**
     * 被本版取代的上一版 —— **具名**记下，不靠"上一版你大概记得"。
     * 更早的版本与它们的清单都**留在磁盘上 / git 历史里**（历史不许改写）。
     */
    superseded,
    testId: 'M6.1 正式复验用验收语料（工作单第 2 项）',
    purpose:
      '**单独**承担正式复验的分母 / 覆盖率 / 正确性与有效性判定；与已用于开发的 dev/calibration ' +
      '**不得混合后靠总分通过**。旧语料（dev/calibration/heldout）作为回归另报。',
    ...review,
    counts: {
      items: items.length,
      alert: items.filter((i) => i.expectedState === 'alert').length,
      noAlert: items.filter((i) => i.expectedState === 'no_alert').length,
    },
    perCategory,
    perArea,
    novelty: {
      rule: `正文不得与旧语料逐字相同；${String(NGRAM)}-gram 重合度上限 ${String(MAX_LEGACY_OVERLAP * 100)}%`,
      maxOverlap: worst,
    },
    artifacts: {
      jsonl: relative(ROOT, JSONL_PATH).split(/[\\/]/).join('/'),
      worksheet: relative(ROOT, WORKSHEET_PATH).split(/[\\/]/).join('/'),
    },
    digests: {
      jsonl: sha256OfText(jsonl),
      worksheet: sha256OfText(sheet),
      itemsSource: sha256OfText(readFileSync(join(ROOT, itemsSource.file), 'utf8')),
    },
    notClaimed: [
      '结构自检通过只说明语料**自洽**，**不**说明任何条目"判得对"。',
      '本构装器**不调用模型、不做试判**——冻结与审核之前，候选判定器不得看这些条目。',
      '本件**不**代人批准：审核栏一律留空。',
    ],
    startedAt,
    finishedAt: new Date().toISOString(),
  }

  if (!write) {
    console.log('\n（默认 dry-run，未写盘；加 --write 才写出 evals/m6.1/acceptance/**）')
    return
  }
  mkdirSync(OUT_DIR, { recursive: true })
  /*
   * ⚠️ 重建时**当场核对语料正文没变**：加一个索引只是多写一个文件，
   * 该版本的 `*.jsonl` 必须逐字不变 —— 否则"审核过的那一版语料"就被悄悄换掉了。
   *
   * 合法出口只有一个：**该版本尚未提交、也未被任何冻结件绑定**（即仍在装配阶段）时，
   * 可以删掉该版本的产物后重建；一旦提交或冻结过，就必须**升版本号**
   * —— 那是新一版语料，不是重建。
   */
  if (existsSync(JSONL_PATH)) {
    const before = sha256OfText(readFileSync(JSONL_PATH, 'utf8'))
    if (before !== manifest.digests.jsonl) {
      throw new MeasurementInvalidError(
        'MEASUREMENT INVALID：重建会改变既有语料的正文' +
          `（${before.slice(0, 12)}… → ${manifest.digests.jsonl.slice(0, 12)}…）⇒ 拒绝写盘。` +
          '若这一版**尚未提交且未被任何冻结件绑定**（仍在装配），可删掉该版本的产物后重建；' +
          '否则请**升版本号**（那是新一版语料，不是重建）。'
      )
    }
  }
  writeFileSync(JSONL_PATH, jsonl, 'utf8')
  writeFileSync(WORKSHEET_PATH, sheet, 'utf8')
  writeFileSync(INDEX_PATH, index, 'utf8')
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log('\n已写出：')
  console.log(`  ${relative(ROOT, JSONL_PATH).split(/[\\/]/).join('/')}  (${String(items.length)} 条 · ${manifest.digests.jsonl.slice(0, 12)}…)`)
  console.log(`  ${relative(ROOT, WORKSHEET_PATH).split(/[\\/]/).join('/')}`)
  console.log(`  ${relative(ROOT, INDEX_PATH).split(/[\\/]/).join('/')}`)
  console.log(`  ${relative(ROOT, MANIFEST_PATH).split(/[\\/]/).join('/')}`)
  console.log(`\n⚠️ 状态是 ${String(manifest.reviewStatus)}：` +
    (manifest.reviewStatus === 'APPROVED'
      ? '已签字，可以进入正式两轮（但仍须先冻结运行配置）。'
      : '签字确认前不得用候选判定器试判这些条目，也不得代填人工批准。'))
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-acceptance] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-acceptance] 这是 MEASUREMENT INVALID，不是"可以继续"')
  }
  process.exit(2)
}
