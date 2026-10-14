/**
 * M5 WP5 —— **Context Selector & Budget**。
 *
 * ============================================================================
 *  它回答的问题是："她这一轮到底能想起多少"
 * ============================================================================
 * 排序已经给了"最该想起的顺序"，这一层给的是**上限**：
 *
 *     Eligible Ranked Candidates  →  Context Selector  →  Budgeted Memory Context
 *
 * 计划书禁掉了最省事的那个绕法：
 *
 *     禁止通过**无限提高 model context length** 来绕过 Context Budget 问题
 *
 * 因此预算来自**配置**（`ContextBudget`），而不是来自"模型窗口有多大"。
 * 这一段还提供 `planContextBudget()`：**七类**上下文各自的额度（AT5.1 的"逻辑区分"，
 * M6 起多了 `rolling_summary` 那一格），并明确 M5 **只**负责其中 `long_term_memory` 那一格。
 *
 * ---------------------------------------------------------------------------
 *  三条纪律
 * ---------------------------------------------------------------------------
 * 1. **估算的就是注入的**。token 数用注入的 `TokenQuantifier` 算在
 *    `renderMemoryEntry()` 的**同一份文本**上（`render.ts`），
 *    最终注入的也是那份文本。两处文本一旦分家，预算就成了"看起来遵守"。
 *
 * 2. **装不下要写 `BUDGET_EXHAUSTED`**（budget 阶段）—— **不是** `LOW_RELEVANCE`。
 *    两者的修法不同：一个改预算，一个改相关性。混起来会让 trace 指向错的修法。
 *
 * 3. **恒等式失败关闭**：`memory + reserved <= total` 必须成立，
 *    选择结果里的 `sum(selected) <= memory` 也必须成立 —— 不成立就抛错，
 *    而不是"这次先超一点"。
 */

import {
  assertContextBundle,
  assertRecallDecision,
  createEmptyContextBundle,
  type ContextBundle,
  type RecallBudgetAccount,
  type RecallCandidate,
  type RecallDecision,
  type RecallRequest,
  type RecallSelectedMemory,
} from '../contracts/recall.ts'
import { KernelError } from '../contracts/ids.ts'
import { MEMORY_BLOCK_HEADER, renderMemoryBlock, renderMemoryEntry } from './render.ts'
import type { RankedCandidate } from './ranking.ts'

// ---------------------------------------------------------------------------
// AT5.1 预算抽象 + AT5.2 长期记忆的明确预算
// ---------------------------------------------------------------------------

export interface ContextBudget {
  /** 整轮上下文的 token 上限（**配置**，不是模型窗口） */
  totalTokens: number
  /** 长期记忆那一块的预算 */
  memoryTokens: number
  /**
   * 为核心类别预留的额度。
   *
   * 它们**不许**被记忆挤掉：身份（她是谁）、当前输入（对方在问什么）
   * 一旦被裁掉，回答就不再是"她"在回答 —— M3 的 `droppable: false`
   * 说的是同一件事（`sections.ts` 的 `SECTION_PRIORITY`）。
   */
  reservedTokens: number
  /**
   * M5.5（ADR-045 `D-16`）：**外部证据**那一块的独立额度。
   *
   * ⚠️ 缺省是 **0**，而且这是刻意的：`CHARACTER_WEB_SEARCH_ENABLED=false` 时
   *    装配层传的就是 0 —— "今天不注入外部证据"是一个**真实**的配置，
   *    不是"忘了填"。M5 的既有判据（`verify-m5-budget.ts`）断言的正是
   *    "缺省预算里 `external_evidence` 恒为 0"，它到现在仍然为真。
   * flag 打开时装配层传 `CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS`（有界，缺省 800）。
   */
  externalEvidenceTokens: number
  /**
   * M6（ADR-050 `DR-7`）：**会话 Rolling Summary** 那一块的独立额度。
   *
   * ⚠️ 缺省是 **0**，而且这是刻意的：0 = "今天不做摘要"是一个**真实**配置，
   *    不是"忘了填"。与 `externalEvidenceTokens` 同构 ——
   *    开/关由**额度是否为 0** 表达，因此**不新增 runtime flag、不新增控制命令**
   *    （ADR-050 `DR-11`，沿用 ADR-043 `DR-10`）。
   *
   * 摘要是**可裁**且**最低优先级**（`SECTION_PRIORITY.rollup` = 20）：
   * 预算不够时先裁它，绝不挤掉身份 / 完整性规则 / 当前输入 / 程序结果事实。
   */
  rollupTokens: number
  /**
   * M10（ADR-076 `D27`）：**目标状态**那一块的独立额度。
   *
   * ⚠️ 缺省是 **0**，而且这是刻意的：0 = "今天不注入目标状态"是一个**真实**配置，
   *    不是"忘了填"。与 `externalEvidenceTokens` / `rollupTokens` 同构 ——
   *    开/关由**额度是否为 0** 表达，因此**不新增 runtime flag、不新增控制命令**
   *    （ADR-050 `DR-11` 的既有纪律）。
   *
   * ⚠️ **不得有影子默认**（`D27` 逐字）：装配层必须把 flag 派生的值传进
   *    **这一个** `ContextBudget`，而不是在 provider 或装配处再写一个 `?? 400`。
   *    影子默认的后果是"配置显示关闭、实际注入了目标" —— 而那正是最难查的一类。
   */
  goalTokens: number
  /**
   * M11（ADR-085 `D27` / `D34`）：**有限自适应自我**那一块的独立额度。
   *
   * ⚠️ 缺省是 **0**，而且这是刻意的：0 = "今天不注入行为策略"是一个**真实**配置。
   *    与 `externalEvidenceTokens` / `rollupTokens` / `goalTokens` 同构。
   *
   * ⚠️⚠️ **它必须真的接线**（`D34`，由 `L-M11-10` 的实测逼出来）：
   *    M10 的 `goalTokens` **从未**被生产装配设置过 —— 于是生产里 `goal-state` 块
   *    永远不可达，而 M10 的判定表写的是 `ACTIVATED`（两者不矛盾，但极易误读）。
   *    ⇒ M11 的值**只**从 `flags → main.ts 的 recallBudget → 这一个 ContextBudget` 传，
   *      并配一条静态回归锁（断言 `src/main.ts` 里真的出现 `adaptiveSelfTokens`）。
   *
   * ⚠️ **不得有影子默认**：装配层必须把 flag 派生的值传进**这一个** `ContextBudget`，
   *    而不是在 provider 或装配处再写一个 `?? 300`。
   */
  adaptiveSelfTokens: number
  /**
   * M10.1（ADR-086 `D09`）：**约定与结清**那一块的独立额度。
   *
   * ⚠️ 缺省 **0**（= 不注入约定状态/结清事实）。与 `externalEvidenceTokens` /
   *    `rollupTokens` / `goalTokens` / `adaptiveSelfTokens` 同构。
   *
   * ⚠️ **它必须真的接线**：M10 的 `goalTokens` 就是因为装配层从未设置它而在生产里
   *    永远不可达（`L-M11-10`）⇒ 本额度**只**从 `flags → main.ts 的 recallBudget →
   *    这一个 ContextBudget` 传，并配静态回归锁（断言 `src/main.ts` 里真的出现
   *    `commitmentTokens`）。**不得有影子默认**（`D27`）。
   */
  commitmentTokens: number
  /**
   * 实用能力加装（计划书 §2 第 3 点）：**当轮内容**（计算 / 文档 / 网页正文 / OCR）的独立额度。
   *
   * ⚠️ 缺省 **0**，而且这是刻意的：四项能力的开关代码缺省全 `off` ⇒
   *    "今天不注入当轮内容"是一个**真实**配置，不是"忘了填"。
   *    与 `externalEvidenceTokens` / `rollupTokens` / `goalTokens` /
   *    `adaptiveSelfTokens` / `commitmentTokens` **同构**。
   *
   * ⚠️ **不得有影子默认**：装配层必须把 flag 派生的值传进**这一个** `ContextBudget`
   *    （先例 `L-M11-10`：`goalTokens` 就是因为在装配层从未被赋值而在生产里永远不可达）。
   *    隔离验收用 2000（计划书 §2 第 3 点），生产缺省 0。
   */
  turnContentTokens: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 6000,
  memoryTokens: 800,
  reservedTokens: 2400,
  /*
   * 0 = 默认不注入外部证据（联网搜索默认关闭）。
   * 注意它**不是**"预留额度"：`assertContextBudget` 只要求
   * 记忆 + 预留 + 外部证据 ≤ 总预算，因此默认配置在数学上仍然成立。
   */
  externalEvidenceTokens: 0,
  /*
   * 0 = 默认不做会话摘要（ADR-050 DR-7）。
   * `assertContextBudget` 只要求 记忆 + 预留 + 外部证据 + 摘要 ≤ 总预算，
   * 因此默认配置（800 + 2400 + 0 + 0 = 3200 ≤ 6000）在数学上仍然成立。
   */
  rollupTokens: 0,
  /*
   * 0 = 默认不注入目标状态（M10 关闭档）。
   * 默认配置在数学上仍然成立：800 + 2400 + 0 + 0 + 0 = 3200 ≤ 6000。
   */
  goalTokens: 0,
  /*
   * 0 = 默认不注入行为策略（M11 关闭档）。
   * 默认配置在数学上仍然成立：800 + 2400 + 0 + 0 + 0 + 0 = 3200 ≤ 6000。
   */
  adaptiveSelfTokens: 0,
  /*
   * 0 = 默认不注入约定状态/结清事实（M10.1 关闭档）。
   * 默认配置在数学上仍然成立：800 + 2400 + 0 + 0 + 0 + 0 + 0 = 3200 ≤ 6000。
   */
  commitmentTokens: 0,
  /*
   * 0 = 默认不注入当轮内容（四项实用能力代码缺省全 off）。
   * 默认配置在数学上仍然成立：800 + 2400 + 0×6 = 3200 ≤ 6000。
   */
  turnContentTokens: 0,
}

/** 七类（AT5.1 的"至少逻辑区分" + M6 的会话摘要） */
export type ContextCategory =
  | 'identity_system'
  | 'character_state'
  | 'current_input'
  | 'recent_conversation'
  | 'long_term_memory'
  | 'external_evidence'
  | 'rolling_summary'
  | 'goal_state'
  | 'adaptive_self'
  /** M10.1：约定与结清（`commitment-state` 块） */
  | 'commitment_state'
  /** 实用能力加装：当轮内容（`turn-content` 块） */
  | 'turn_content'

export interface ContextCategoryPlan {
  category: ContextCategory
  tokens: number
  /** 谁负责填它（**M5 只填 long_term_memory**） */
  producer: string
  /** 缺了它还能不能回答（true = 可以被裁） */
  droppable: boolean
}

/**
 * 把预算摊成六类（**纯函数**，可测）。
 *
 * 它存在的意义是让"记忆能占多少"是一个**可审阅的数字**，而不是
 * "provider 谁先跑谁先占"。计划书的六类里，M5 的实际产出只有一格：
 * `long_term_memory`；`external_evidence` 恒为 0（M5.5 才填）。
 */
export function planContextBudget(budget: ContextBudget): ContextCategoryPlan[] {
  assertContextBudget(budget)
  const core = budget.reservedTokens
  // 核心四类怎么分是 WP6 的事；这里给出的是"它们合起来占多少"的可审阅视图，
  // 因此按经验比例摊开，并在 producer 里写明归属。
  const identity = Math.round(core * 0.25)
  const state = Math.round(core * 0.15)
  const currentInput = Math.round(core * 0.1)
  const recent = core - identity - state - currentInput
  return [
    { category: 'identity_system', tokens: identity, producer: 'WP6 · identity-core / integrity-rules', droppable: false },
    { category: 'current_input', tokens: currentInput, producer: 'WP6 · current-input', droppable: false },
    { category: 'recent_conversation', tokens: recent, producer: 'WP6 · recent-conversation', droppable: true },
    { category: 'character_state', tokens: state, producer: 'WP6 · critical-state', droppable: true },
    {
      category: 'long_term_memory',
      tokens: budget.memoryTokens,
      producer: 'M5 WP5 · 本文件（Context Selector）',
      droppable: true,
    },
    {
      category: 'external_evidence',
      tokens: budget.externalEvidenceTokens,
      producer: 'M5.5 · Web Search（`web.search` → 本地 SearXNG）；额度只在该能力启用时非零',
      droppable: true,
    },
    {
      category: 'rolling_summary',
      tokens: budget.rollupTokens,
      producer: 'M6 · Rolling Summary（ADR-050；逐字摘录，额度缺省 0 = 不做摘要）',
      droppable: true,
    },
    {
      category: 'goal_state',
      tokens: budget.goalTokens,
      producer:
        'M10 · Goals & Commitments（ADR-076 `D27`；至多 1 焦点 / 1 当前步骤 / 3 项，' +
        '额度缺省 0 = 不注入目标状态）',
      droppable: true,
    },
    {
      category: 'adaptive_self',
      tokens: budget.adaptiveSelfTokens,
      producer:
        'M11 · Reflection & Adaptive Self（ADR-085 `D27`/`D34`；至多 3 条**程序模板**，' +
        '额度缺省 0 = 不注入行为策略；`D34` 要求该额度**真的**由装配层传入）',
      droppable: true,
    },
    {
      category: 'commitment_state',
      tokens: budget.commitmentTokens,
      producer:
        'M10.1 · 约定与结清（ADR-086 `D09`；结清行「不要再提」优先、未结清行照常，' +
        '额度缺省 0 = 不注入约定状态）',
      droppable: true,
    },
    {
      category: 'turn_content',
      tokens: budget.turnContentTokens,
      producer:
        '实用能力加装 · 当轮内容（计算 / 文档 / 网页正文 / OCR；' +
        '四项开关代码缺省 off ⇒ 额度缺省 0 = 不注入当轮内容）',
      droppable: true,
    },
  ]
}

/** 失败关闭的预算校验（配置错了要在装配时炸，而不是在对话里超） */
export function assertContextBudget(budget: ContextBudget): void {
  for (const key of [
    'totalTokens',
    'memoryTokens',
    'reservedTokens',
    'externalEvidenceTokens',
    'rollupTokens',
    'goalTokens',
    'adaptiveSelfTokens',
    'commitmentTokens',
    'turnContentTokens',
  ] as const) {
    const value = budget[key]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new KernelError(
        'validation_error',
        'recall_bad_budget',
        `ContextBudget.${key} 必须是 ≥ 0 的整数，收到 ${String(value)}`
      )
    }
  }
  const committed =
    budget.memoryTokens +
    budget.reservedTokens +
    budget.externalEvidenceTokens +
    budget.rollupTokens +
    budget.goalTokens +
    budget.adaptiveSelfTokens +
    budget.commitmentTokens +
    budget.turnContentTokens
  if (committed > budget.totalTokens) {
    throw new KernelError(
      'validation_error',
      'recall_budget_overcommitted',
      `记忆预算(${budget.memoryTokens}) + 预留(${budget.reservedTokens}) + ` +
        `外部证据(${budget.externalEvidenceTokens}) + 会话摘要(${budget.rollupTokens}) + ` +
        `目标状态(${budget.goalTokens}) + 行为策略(${budget.adaptiveSelfTokens}) + ` +
        `约定与结清(${budget.commitmentTokens}) + ` +
        `当轮内容(${budget.turnContentTokens}) ` +
        `超过总预算(${budget.totalTokens}) —— ` +
        '这个配置在数学上就不可能被遵守，因此它在装配时就该失败，' +
        '而不是等到某次对话里悄悄超'
    )
  }
}

// ---------------------------------------------------------------------------
// AT5.3 确定性选择 + AT5.4 重复不浪费预算 + AT5.5 账目
// ---------------------------------------------------------------------------

export type TokenQuantifier = (text: string) => number

export interface SelectMemoryContextInput {
  request: RecallRequest
  /** **只**传 `rankCandidates().ranked`（已排序、已去重） */
  ranked: readonly RankedCandidate[]
  budget: ContextBudget
  /** token 量化器（基础设施注入；缺省按字符估算，与 ContextCompiler 的缺省一致） */
  quantifier?: TokenQuantifier
  /** Optional presentation policy; eligibility/ranking and token budgets still apply. */
  injectionLimit?: number
  now: number
}

export interface SelectedEntry {
  memoryId: string
  /** 注入时用的那一行文本（与估算用的是同一份） */
  text: string
  estimatedTokens: number
}

export interface MemoryContextSelection {
  /** 注入用的数据块（空选择时是空串） */
  blockText: string
  entries: SelectedEntry[]
  /** WP1 契约的 bundle（`assertContextBundle` 已经过） */
  bundle: ContextBundle
  /** 预算阶段被淘汰的决策（`BUDGET_EXHAUSTED` / `DUPLICATE`）—— 终局 */
  decisions: RecallDecision[]
}

export function selectMemoryContext(input: SelectMemoryContextInput): MemoryContextSelection {
  const quantifier = input.quantifier ?? ((text: string) => Math.ceil(text.length / 2))
  assertContextBudget(input.budget)
  if (input.injectionLimit !== undefined && (!Number.isSafeInteger(input.injectionLimit) || input.injectionLimit < 1)) {
    throw new KernelError('validation_error', 'recall_bad_injection_limit', '记忆注入条数上限必须是正整数')
  }

  const decisions: RecallDecision[] = []
  const entries: SelectedEntry[] = []
  const selected: RecallSelectedMemory[] = []
  const chargedSlots = new Set<string>()
  let used = 0

  for (const item of input.ranked) {
    const candidate = item.candidate
    const memoryId = String(candidate.memoryId)
    // A caller bypassing eligibility must not render unauthorized ranked material.
    if (input.request.scope !== undefined && (candidate.authorization?.allowed !== true ||
      JSON.stringify(candidate.authorization.scope) !== JSON.stringify(input.request.scope))) {
      throw new KernelError('validation_error', 'recall_scope_not_authorized', '候选缺少当前作用域授权')
    }

    /*
     * AT5.4：**重复不浪费预算**（预算阶段的最后一道）。
     *
     * WP4 已经按内容指纹与槽位做过一次去重；这里再挡一次是**防御性**的，
     * 因为"绕过 WP4 直接喂 ranked"是完全可能的（WP6 的接线就可能写错）。
     * 判据用**槽位指纹**（同一个槽位 + 同一个取值 = 真重复），
     * 而不是"同一个槽位"—— 问"以前"时"当前 + 一条历史"是**刻意**要两条的。
     */
    if (candidate.slotFingerprint !== undefined) {
      if (chargedSlots.has(candidate.slotFingerprint)) {
        decisions.push(finalDecision({ memoryId, reason: 'DUPLICATE' }))
        continue
      }
    }

    if (input.injectionLimit !== undefined && entries.length >= input.injectionLimit) {
      decisions.push(finalDecision({ memoryId, reason: 'INJECTION_LIMIT' }))
      continue
    }
    const text = renderMemoryEntry({
      dataText: candidate.dataText,
      authority: candidate.authority,
      status: candidate.status,
      // Phase 4b（ADR-043 §3.3 ⑦）：标签后缀。ESTABLISHED / 不适用 ⇒ 空串（输出不变）
      ...(candidate.qualification !== undefined ? { qualification: candidate.qualification } : {}),
    })
    const cost = quantifier(text)

    if (used + cost > input.budget.memoryTokens) {
      /*
       * 装不下 —— 理由必须是 BUDGET_EXHAUSTED（budget 阶段）。
       * 继续往下看而**不是**就此收工：后面的候选可能更小，
       * 于是剩余预算能被用满；而"按优先级顺序取"这条性质没有被破坏
       * （我们从不重排，只跳过装不下的）。
       */
      decisions.push(finalDecision({ memoryId, reason: 'BUDGET_EXHAUSTED' }))
      continue
    }

    used += cost
    if (candidate.slotFingerprint !== undefined) chargedSlots.add(candidate.slotFingerprint)
    entries.push({ memoryId, text, estimatedTokens: cost })
    selected.push({
      memoryId: candidate.memoryId,
      dataText: candidate.dataText,
      type: candidate.type,
      authority: candidate.authority,
      epistemicStatus: candidate.epistemicStatus,
      subjects: candidate.subjects,
      sourceRefs: candidate.sourceRefs,
      ...(candidate.canonicalKey !== undefined ? { canonicalKey: candidate.canonicalKey } : {}),
      contentFingerprint: candidate.contentFingerprint,
      recordedAt: candidate.recordedAt,
      estimatedTokens: cost,
      score: item.score,
      ...(candidate.qualification !== undefined ? { qualification: candidate.qualification } : {}),
    })
  }

  const account: RecallBudgetAccount = {
    budgetTokens: input.budget.memoryTokens,
    memoryTokens: used,
    reservedTokens: input.budget.reservedTokens,
    totalTokens: input.budget.reservedTokens + used,
  }

  assertSelectionInvariant({ account, entries, selectedCount: selected.length })

  const blockText = renderMemoryBlock(entries.map((entry) => entry.text))

  const bundle: ContextBundle =
    selected.length === 0
      ? createEmptyContextBundle({
          request: input.request,
          decisions,
          now: input.now,
        })
      : {
          traceId: input.request.traceId,
          characterId: input.request.characterId,
          user: input.request.user,
          generatedAt: input.now,
          request: input.request,
          candidates: input.ranked.map((item) => item.candidate),
          decisions: [
            ...input.ranked
              .filter((item) => selected.some((s) => String(s.memoryId) === String(item.candidate.memoryId)))
              .map((item) => finalDecision({ memoryId: String(item.candidate.memoryId), selected: true })),
            ...decisions,
          ],
          selected,
          budget: account,
          externalEvidence: [],
          integrityNotices: [],
        }

  // 空 bundle 与要注入的 blockText 都过契约断言（两条分支都要测，不能只测一条）
  assertContextBundle(bundle)

  return { blockText, entries, bundle, decisions }
}

function finalDecision(input: {
  memoryId: string
  selected?: boolean
  reason?: RecallDecision['reason']
}): RecallDecision {
  const decision: RecallDecision = {
    memoryId: input.memoryId as unknown as RecallDecision['memoryId'],
    eligible: true,
    selected: input.selected ?? false,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
  // 契约断言：未选中必须有理由、阶段必须一致（budget 阶段的理由是 BUDGET_EXHAUSTED）
  assertRecallDecision(decision)
  return decision
}

/**
 * 恒等式（**失败关闭**）。
 *
 * 计划书的 Hard Test 写得很硬：`total context <= configured budget` **必须始终成立**。
 * 因此它不是一个"跑一遍看看"的测试，而是每次选择都要过的一道闸 ——
 * 越界时抛错并回滚，而不是"这次先超一点"。
 */
export function assertSelectionInvariant(input: {
  account: RecallBudgetAccount
  entries: readonly SelectedEntry[]
  selectedCount: number
}): void {
  const sum = input.entries.reduce((total, entry) => total + entry.estimatedTokens, 0)
  if (sum !== input.account.memoryTokens) {
    throw new KernelError(
      'validation_error',
      'recall_budget_account_mismatch',
      `账目与逐条合计不一致：memoryTokens=${input.account.memoryTokens}，逐条合计=${sum}`
    )
  }
  if (input.account.memoryTokens > input.account.budgetTokens) {
    throw new KernelError(
      'validation_error',
      'recall_budget_exceeded',
      `记忆块 ${input.account.memoryTokens} tokens 超过记忆预算 ${input.account.budgetTokens} —— ` +
        '预算的第一条用途就是"永远装得下"'
    )
  }
  if (input.account.totalTokens > input.account.budgetTokens + input.account.reservedTokens) {
    throw new KernelError(
      'validation_error',
      'recall_budget_exceeded',
      `总占用 ${input.account.totalTokens} 超过 记忆预算 + 预留 ` +
        `${input.account.budgetTokens + input.account.reservedTokens}`
    )
  }
  if (input.entries.length !== input.selectedCount) {
    throw new KernelError(
      'validation_error',
      'recall_budget_account_mismatch',
      `entries(${input.entries.length}) 与 selected(${input.selectedCount}) 数量不一致`
    )
  }
}

/** 便于诊断/证据：账目压成一行 */
export function describeBudgetAccount(account: RecallBudgetAccount): string {
  return (
    `memory=${account.memoryTokens}/${account.budgetTokens} ` +
    `reserved=${account.reservedTokens} total=${account.totalTokens}` +
    `${account.conversationTokens !== undefined ? ` conversation=${account.conversationTokens}` : ''}`
  )
}

/** 数据块的标题（WP6 注入时用同一份常量，避免两处标题漂移） */
export const SELECTED_MEMORY_BLOCK_HEADER = MEMORY_BLOCK_HEADER
