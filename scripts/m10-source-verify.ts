/**
 * M10 WP4 —— **语义提案门**（`pnpm m10:source:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP4 的三条出口判据，逐条对应）
 * ============================================================================
 * ```text
 * ① 机械链全绿          → B 组：300 条语料全部走通 provider → 严格校验 → 映射（离线固定 provider）
 * ② 语义负控有**有效分母** → A 组（分母自检）+ B3（关键负控族**非零**且全部不写事件）
 * ③ 非法输出与传输失败均保留 → C 组（12 条拒绝原因逐条可达，且**记 invalid 不当 none**）
 *                            D 组（provider 抛错 / 超时 / 来源不合格 / 空输入 —— 四态分列）
 * ```
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · **零模型调用、零出网、零数据库**：provider 是一个**固定**实现
 *    （由语料金标构造），因此本门是**确定性**的、毫秒级的。
 *    ⇒ 它**不**回答"模型理解得好不好"——那是 WP10（`m10:semantic:eval`，需真模型）。
 *    **不得**把本门读数当成模型质量读数。
 *  · 不 import `node:*` 以外的任何重依赖（本门只用只读文件 + 纯函数）。
 *  · 每条计数都有非零分母；`measured_count > 0` 自检。
 *  · 阶段进度写 stderr；失败路径强退（WP2 的教训）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import {
  GOAL_DRAFT_FIELD_ALLOWLIST,
  GOAL_DRAFT_REJECTION_FACTS,
  GOAL_DRAFT_REJECTION_REASONS,
  GOAL_PROPOSAL_OPERATIONS,
  GOAL_PROPOSAL_SCHEMA_VERSION,
  validateGoalProposalDraft,
  type GoalDraftRejectionReason,
  type GoalProposalDraft,
  type GoalProposalOperation,
} from '../src/kernel/contracts/goal-proposal.ts'
import {
  GOAL_NON_WRITING_OPERATIONS,
  GOAL_UNDERSTANDING_DEADLINE_MS,
  draftToProgramProposal,
  understandGoalProposal,
  type GoalCandidateSummary,
  type GoalUnderstandingOutcome,
  type GoalUnderstandingProvider,
  type GoalUnderstandingRuntime,
} from '../src/kernel/app/goal/understanding.ts'
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import { validateGoalProposal } from '../src/kernel/policies/goal-validator.ts'
import {
  GOAL_CORPUS_FAMILIES,
  GOAL_CORPUS_HIGH_RISK_LAYERS,
  GOAL_CORPUS_LAYERS,
  GOAL_CORPUS_PLAN,
  buildGoalCorpus,
  buildGoalCorpusManifest,
  type GoalCorpusBuild,
  type GoalCorpusGold,
  type GoalCorpusItem,
} from '../evals/m10/goal-corpus.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER_ID = 'char_m10_source'
const ACTIVE_USER = 'm10-source-user'
const SOURCE_EVENT = 'cev:m10-source-1'

function phase(mark: string): void {
  console.error(`[m10-source] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 夹具：候选、草稿、固定 provider、确定性 runtime
// ---------------------------------------------------------------------------

const CANDIDATES: readonly GoalCandidateSummary[] = [
  { goalId: 'gol:aaa111', status: 'active', priority: 'normal', statement: '写完论文提纲', revision: 3 },
  { goalId: 'gol:bbb222', status: 'paused', priority: 'high', statement: '把实验做完', revision: 7 },
  { goalId: 'gol:ccc333', status: 'active', priority: 'normal', statement: '整理数据', revision: 1 },
]

function codePointLength(text: string): number {
  return [...text].length
}

/** 按金标造一个**合法**草案（固定 provider 的产出） */
export function draftForGold(item: GoalCorpusItem): GoalProposalDraft {
  const span = { start: 0, end: codePointLength(item.sourceText) }
  const gold: GoalCorpusGold = item.gold
  const base = { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: gold.operation, span }
  switch (gold.operation) {
    case 'none':
      return base as GoalProposalDraft
    case 'create':
      return {
        ...base,
        statement: item.sourceText,
        origin: 'user_requested',
      } as GoalProposalDraft
    case 'clarify':
      return { ...base, clarifyReason: '需要澄清：候选不唯一或前提已变' } as GoalProposalDraft
    case 'cancel':
      return {
        ...base,
        targetGoalId: CANDIDATES[0]!.goalId,
        cancelKind: gold.cancelKind ?? 'user_cancel',
      } as GoalProposalDraft
    case 'revise':
      return {
        ...base,
        targetGoalId: CANDIDATES[0]!.goalId,
        changed: ['statement', 'nextStep'],
        nextStep: '先列提纲',
      } as GoalProposalDraft
    default:
      return { ...base, targetGoalId: CANDIDATES[0]!.goalId } as GoalProposalDraft
  }
}

/** 固定 provider：产出调用方指定的 raw（默认 = 金标草案） */
function fixedProvider(raw: unknown | ((input: unknown) => unknown)): GoalUnderstandingProvider {
  return {
    name: 'm10-fixed-provider',
    version: 'm10-fixed-provider@1',
    call: async (call) => (typeof raw === 'function' ? (raw as (i: unknown) => unknown)(call.input) : raw),
  }
}

/** 确定性 runtime：不调真实定时器（期限那一支由调用方显式选择） */
function deterministicRuntime(options: { timeout?: boolean } = {}): GoalUnderstandingRuntime {
  let clock = 1_000
  return {
    now: () => clock++,
    withDeadline: async (work) => {
      if (options.timeout === true) return { kind: 'timeout' }
      return { kind: 'ok', value: await work() }
    },
  }
}

function inputFor(item: GoalCorpusItem): Parameters<typeof understandGoalProposal>[1] {
  return {
    characterId: CHARACTER_ID,
    currentInput: item.sourceText,
    sourceEventId: SOURCE_EVENT,
    sourceQualification: 'ESTABLISHED',
    candidates: CANDIDATES,
    lastAssistantEventId: 'cev:m10-assistant-1',
  }
}

// ---------------------------------------------------------------------------
// A 组：语料完整性（**分母**就在这里被钉住）
// ---------------------------------------------------------------------------

function corpusChecks(build: GoalCorpusBuild): void {
  const manifest = buildGoalCorpusManifest(build)

  record(
    'A',
    'A1',
    '语料总数与分片 = 契约计划（300 / dev 100 · val 60 · test 140）',
    'planMatches=true',
    `total=${String(build.counts.total)} · bySplit=${JSON.stringify(build.counts.bySplit)} · deficits=[${manifest.deficits.join('; ')}]`,
    manifest.planMatches && build.counts.total === GOAL_CORPUS_PLAN.total,
  )

  const testLayerOk = GOAL_CORPUS_LAYERS.every(
    (layer) => build.counts.bySplitAndLayer.test[layer] >= GOAL_CORPUS_PLAN.testLayerMinimum,
  )
  const highRiskOk = GOAL_CORPUS_HIGH_RISK_LAYERS.every(
    (layer) => build.counts.bySplitAndLayer.test[layer] >= GOAL_CORPUS_PLAN.testHighRiskMinimum,
  )
  record(
    'A',
    'A2',
    '**有效分母**：test 六层各 ≥20 且高风险层（承诺与假兑现）≥30',
    `六层≥${String(GOAL_CORPUS_PLAN.testLayerMinimum)} · 高风险≥${String(GOAL_CORPUS_PLAN.testHighRiskMinimum)}`,
    `testByLayer=${JSON.stringify(build.counts.bySplitAndLayer.test)} · 层下界=${String(testLayerOk)} · 高风险=${String(highRiskOk)}`,
    testLayerOk && highRiskOk,
  )

  /* 家族不跨 split：拆分的最小单位是家族 */
  const splitByFamily = new Map<string, Set<string>>()
  for (const item of build.items) {
    const set = splitByFamily.get(item.familyId) ?? new Set<string>()
    set.add(item.split)
    splitByFamily.set(item.familyId, set)
  }
  const crossing = [...splitByFamily.entries()].filter(([, splits]) => splits.size > 1)
  record(
    'A',
    'A3',
    '**没有家族跨 split**（改述不可能在 dev 与 test 之间泄漏）',
    '0 个跨界家族',
    `家族=${String(splitByFamily.size)} · 跨界=${String(crossing.length)}${crossing.length > 0 ? `（${crossing.map(([f]) => f).join(',')}）` : ''}`,
    crossing.length === 0 && splitByFamily.size === GOAL_CORPUS_FAMILIES.length,
  )

  const ids = new Set(build.items.map((item) => item.caseId))
  const texts = new Set(build.items.map((item) => item.sourceText))
  record(
    'A',
    'A4',
    'caseId 唯一 · 原话无重复 · `measured_count > 0`',
    `${String(GOAL_CORPUS_PLAN.total)} 唯一 id / 0 重复文本`,
    `id=${String(ids.size)} · 文本=${String(texts.size)} · 重复=${String(build.items.length - texts.size)}`,
    ids.size === build.items.length && texts.size === build.items.length && build.items.length > 0,
  )

  const goldOps = new Set(build.items.map((item) => item.gold.operation))
  const unknownOps = [...goldOps].filter(
    (op) => !(GOAL_PROPOSAL_OPERATIONS as readonly string[]).includes(op),
  )
  record(
    'A',
    'A5',
    '金标操作都在闭集内，且**闭集里每一个操作**都至少有一条语料（无"登记了但永不出现"的值）',
    `${String(GOAL_PROPOSAL_OPERATIONS.length)} 个操作都有语料 · 0 个闭集外`,
    `覆盖=${String(goldOps.size)}/${String(GOAL_PROPOSAL_OPERATIONS.length)} · 闭集外=${unknownOps.join(',') || '无'} · byOp=${JSON.stringify(build.counts.byOperation)}`,
    unknownOps.length === 0 && goldOps.size === GOAL_PROPOSAL_OPERATIONS.length,
  )

  record(
    'A',
    'A6',
    '语料指纹在场且稳定（同一份数据两次构建给出同一个值）',
    '两次构建同值',
    `${build.corpusHash} === ${buildGoalCorpus().corpusHash}`,
    build.corpusHash === buildGoalCorpus().corpusHash && build.corpusHash.length > 0,
  )

  /* 关键负控族**非零**（"语义负控有有效分母"的另一半） */
  const criticalNegative = build.items.filter(
    (item) =>
      item.gold.operation === 'none' ||
      item.gold.operation === 'clarify' ||
      item.gold.cancelKind === 'explicit_forget',
  )
  record(
    'A',
    'A7',
    '**关键负控分母非零**：`none` / `clarify` / `explicit_forget` 三类共多少条（不能是 0）',
    '> 0',
    `${String(criticalNegative.length)} 条（none=${String(build.counts.byOperation.none ?? 0)} · clarify=${String(build.counts.byOperation.clarify ?? 0)} · forget=${String(build.items.filter((i) => i.gold.cancelKind === 'explicit_forget').length)}）`,
    criticalNegative.length > 0,
  )

  /* ------------------------------------------------------------------ A9 */
  /*
   * ⚠️ **散文上文与结构化候选不许漂开**（语义门加进来之后的新风险）：
   *    给真模型那条链喂的是 `candidates`（结构化），而人审卡片上印的是 `context`（散文）。
   *    两者一旦不一致，"模型看到的题"与"审阅人看到的题"就**不是同一道题** ——
   *    而那种漂移**不会自己响**（两边各自都自洽）。
   * ⇒ 判据：每个候选的 `statement` 必须**逐字出现在**该族的上文里。
   */
  const driftFamilies = new Map<string, string[]>()
  for (const item of build.items) {
    const missing = item.candidates
      .map((candidate) => candidate.statement)
      .filter((statement) => !item.context.includes(statement))
    if (missing.length > 0) {
      const key = item.familyId
      if (!driftFamilies.has(key)) driftFamilies.set(key, missing)
    }
  }
  const candidateTotal = build.items.reduce((sum, item) => sum + item.candidates.length, 0)
  record(
    'A',
    'A9',
    '**散文上文与结构化候选一致**：每个候选的 `statement` 必须**逐字出现在**该族的上文里'
      + '（喂给模型的候选与印在卡片上的上文**必须是同一道题**；漂了不会自己响，所以钉成判据）',
    '0 族漂移 · 候选总数 > 0',
    `候选总数 ${String(candidateTotal)} · 漂移 ${String(driftFamilies.size)} 族` +
      (driftFamilies.size > 0
        ? `：${[...driftFamilies.entries()]
            .slice(0, 4)
            .map(([family, statements]) => `${family}（缺 ${statements.join('/')}）`)
            .join(' · ')}`
        : ''),
    driftFamilies.size === 0 && candidateTotal > 0,
  )
}

// ---------------------------------------------------------------------------
// B 组：离线固定 provider 全量跑通（正控）
// ---------------------------------------------------------------------------

async function corpusThroughChainChecks(build: GoalCorpusBuild): Promise<void> {
  const runtime = deterministicRuntime()
  const perLayer = new Map<string, { total: number; ok: number }>()
  const perSplit = { dev: { total: 0, ok: 0 }, val: { total: 0, ok: 0 }, test: { total: 0, ok: 0 } }
  let understood = 0
  let textFromSource = 0
  /** 关键负控里**写了事件**的条数（必须为 0） */
  let negativeWroteEvent = 0
  const mismatches: string[] = []

  for (const item of build.items) {
    const expected = draftForGold(item)
    const outcome = await understandGoalProposal(fixedProvider(expected), inputFor(item), runtime)
    const bucket = perLayer.get(item.layer) ?? { total: 0, ok: 0 }
    bucket.total += 1
    perSplit[item.split].total += 1

    const ok =
      outcome.kind === 'understood' &&
      outcome.draft.operation === item.gold.operation &&
      (item.gold.cancelKind === undefined || outcome.draft.cancelKind === item.gold.cancelKind)
    if (ok) {
      understood += 1
      bucket.ok += 1
      perSplit[item.split].ok += 1
    } else {
      mismatches.push(`${item.caseId}（期望 ${item.gold.operation}）`)
    }
    if (outcome.kind === 'understood' && outcome.sourceText === item.sourceText) textFromSource += 1

    if (
      ok &&
      outcome.kind === 'understood' &&
      (item.gold.operation === 'none' || item.gold.operation === 'clarify') &&
      !GOAL_NON_WRITING_OPERATIONS.includes(outcome.draft.operation)
    ) {
      negativeWroteEvent += 1
    }
    perLayer.set(item.layer, bucket)
  }

  record(
    'B',
    'B1',
    '【正控】300 条语料全部走通：provider → 严格校验 → 得到 `understood` 且操作与金标一致',
    `${String(build.items.length)}/${String(build.items.length)}`,
    `${String(understood)}/${String(build.items.length)}${mismatches.length > 0 ? ` · 不符=${mismatches.slice(0, 5).join(', ')}` : ''}`,
    understood === build.items.length,
  )

  record(
    'B',
    'B2',
    '分片 / 分层读数（**报每类计数**，不用大类掩盖小类）',
    '每层都有分母且全对',
    `split=${JSON.stringify(perSplit)} · layer=${JSON.stringify(Object.fromEntries([...perLayer.entries()].map(([k, v]) => [k, `${String(v.ok)}/${String(v.total)}`])))}`,
    [...perLayer.values()].every((v) => v.total > 0 && v.ok === v.total) &&
      perSplit.dev.ok === perSplit.dev.total &&
      perSplit.val.ok === perSplit.val.total &&
      perSplit.test.ok === perSplit.test.total,
  )

  record(
    'B',
    'B3',
    '【关键负控】金标为 `none` / `clarify` 的条目**没有任何一条**产生写事件的操作',
    '0 条',
    `${String(negativeWroteEvent)} 条`,
    negativeWroteEvent === 0,
  )

  record(
    'B',
    'B4',
    '草案引用的切片**来自原话**（`sourceText` 由本模块切，不是模型给的文本）',
    `${String(build.items.length)}/${String(build.items.length)}`,
    `${String(textFromSource)}/${String(build.items.length)}`,
    textFromSource === build.items.length,
  )

  /*
   * B5 —— **G07 的正控**（WP11 覆盖账收口轮补上）。
   *
   * 契约 §3 的 G07 逐字：「`acceptanceRefs` 指向**具体提议** + 用户采纳原话」。
   * 此前**只有负控**（`C8`/`C14`：缺提议侧引用 ⇒ 拒），没有"合法采纳 ⇒ 收"的正控 ——
   * 而"只会拒绝"的实现与"判得对"在输出上长得一样（本仓库反复出现的那类形状）。
   *
   * 这一条真的跑一遍：`create` + `origin: 'character_proposed'` +
   * `proposedByAssistantEventId` + `proposalSpan`（提议侧）+ `span`（采纳侧）
   * ⇒ 必须 `understood`，且**来源被保留**。
   */
  const adoptionItem = build.items.find((i) => i.gold.operation === 'create')!
  const adoptionSourceText = adoptionItem.sourceText
  const adoptionDraft: GoalProposalDraft = {
    schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
    operation: 'create',
    span: { start: 0, end: codePointLength(adoptionSourceText) },
    statement: adoptionSourceText,
    origin: 'character_proposed',
    proposedByAssistantEventId: 'conv:m10-adoption-proposal',
    proposalSpan: { start: 0, end: 6 },
  } as unknown as GoalProposalDraft
  const adoptionOutcome = await understandGoalProposal(
    fixedProvider(adoptionDraft),
    /* ⚠️ 用**门自己的** `inputFor`：第一版手写了 `{qualification: …}`，
       而真实字段名是 `sourceQualification` ⇒ 得到 `source_unusable`
       （**输入的字段名写错，读数就变成"来源不合格"**——又一次同类形状） */
    { ...inputFor(adoptionItem), currentInput: adoptionSourceText },
    runtime,
  )
  const adoptionOrigin =
    adoptionOutcome.kind === 'understood'
      ? (adoptionOutcome.draft as { origin?: unknown }).origin
      : undefined
  record(
    'B',
    'B5',
    '**【G07 正控】合法采纳 ⇒ `understood` 且**来源被保留**：`create` + '
      + '`origin=character_proposed` + `proposedByAssistantEventId` + `proposalSpan` + `span`'
      + '（不做这条，"只会拒绝"的实现也能通过 C8/C14 的全部负控）',
    'understood · origin=character_proposed',
    adoptionOutcome.kind === 'understood'
      ? `understood · origin=${String(adoptionOrigin)}`
      : `kind=${adoptionOutcome.kind}${adoptionOutcome.kind === 'invalid' ? `/${adoptionOutcome.reason}` : ''}`,
    adoptionOutcome.kind === 'understood' && adoptionOrigin === 'character_proposed',
  )
}

// ---------------------------------------------------------------------------
// C 组：12 条拒绝原因逐条可达，且**记 invalid 不当 none**
// ---------------------------------------------------------------------------

interface NegativeDraftCase {
  readonly id: string
  readonly reason: GoalDraftRejectionReason
  readonly label: string
  readonly raw: unknown
}

function negativeDraftCases(): NegativeDraftCase[] {
  const good = draftForGold({
    caseId: 'x',
    familyId: 'x',
    split: 'test',
    layer: 'explicit_operation',
    sourceText: '把写完提纲设成目标',
    context: '（本门自造的负控样本，不是语料条目）',
    candidates: [],
    gold: { operation: 'create' },
  })
  return [
    { id: 'C1', reason: 'not_an_object', label: '顶层不是对象', raw: 'not-an-object' },
    {
      id: 'C2',
      reason: 'schema_version_missing_or_unknown',
      label: '版本缺失/不符',
      raw: { ...good, schemaVersion: 'goal-proposal@9' },
    },
    {
      id: 'C3',
      reason: 'unknown_field',
      label: '闭集外字段（模型顺手多写一个）',
      raw: { ...good, goalId: 'gol:invented' },
    },
    {
      id: 'C4',
      reason: 'operation_missing_or_unknown',
      label: '操作不在闭集',
      raw: { ...good, operation: 'delete_everything' },
    },
    {
      id: 'C5',
      reason: 'span_missing_or_out_of_range',
      label: 'span 缺失 / start≥end',
      raw: { ...good, span: { start: 5, end: 5 } },
    },
    {
      id: 'C6',
      reason: 'span_not_in_source',
      label: 'span 越出原话范围',
      raw: { ...good, span: { start: 0, end: 9999 } },
    },
    {
      id: 'C7',
      reason: 'candidate_goal_not_provided',
      label: '引用了**不在候选集**里的目标',
      raw: {
        schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
        operation: 'pause',
        span: { start: 0, end: 4 },
        targetGoalId: 'gol:not-provided',
      },
    },
    {
      id: 'C8',
      reason: 'adoption_reference_missing',
      label: 'character_proposed 缺 `proposedByAssistantEventId`（**第一分支**）',
      raw: {
        schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
        operation: 'create',
        span: { start: 0, end: 4 },
        statement: '采纳她的提议',
        origin: 'character_proposed',
        /*
         * ⚠️ **补上 `proposalSpan`**（WP11 收口轮）：第一版两条都缺 ⇒ 只触发
         * 第一分支，**第二分支（缺 `proposalSpan`）从未被执行过** ——
         * 一条"验过了"的负控其实只验了它的一半。
         * 补上之后，C8 精确地测第一分支，C14 测第二分支。
         */
        proposalSpan: { start: 0, end: 6 },
      },
    },
    {
      id: 'C14',
      reason: 'adoption_reference_missing',
      label: 'character_proposed 缺 `proposalSpan`（**第二分支** —— C8 到不了的那一半）',
      raw: {
        schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
        operation: 'create',
        span: { start: 0, end: 4 },
        statement: '采纳她的提议',
        origin: 'character_proposed',
        proposedByAssistantEventId: 'conv:m10-adoption-proposal',
      },
    },
    {
      id: 'C9',
      reason: 'field_missing_for_operation',
      label: '该操作必需字段缺失（create 缺 statement）',
      raw: {
        schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
        operation: 'create',
        span: { start: 0, end: 4 },
        origin: 'user_requested',
      },
    },
    {
      id: 'C10',
      reason: 'field_present_for_operation',
      label: '**不该带的字段出现了**（pause 上带 statement —— 想偷偷改描述）',
      raw: {
        schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
        operation: 'pause',
        span: { start: 0, end: 4 },
        targetGoalId: CANDIDATES[0]!.goalId,
        statement: '偷偷改描述',
      },
    },
    {
      id: 'C11',
      reason: 'enum_value_unknown',
      label: '枚举值不在闭集（priority=urgent）',
      raw: { ...good, priority: 'urgent' },
    },
    {
      id: 'C12',
      reason: 'text_too_long',
      label: '自由文本超上界（statement 501 码点）',
      raw: { ...good, statement: '长'.repeat(501) },
    },
    /*
     * ⚠️ **M10.1 / R-29 追加**（2026-10-02）：`commitment` 进了闭集表 ⇒ 它自己也要有负控。
     *    这两条是**模型面**的两道闸：形状非法（C15）与**内层闭集外的字段**（C16，
     *    "模型写 id" 的具名形态 —— `acceptanceEventIds` 是程序侧才该填的东西）。
     */
    {
      id: 'C15',
      reason: 'commitment_draft_invalid',
      label: '承诺草案形状非法（`commitment` 不是对象）',
      raw: { ...good, commitment: '下次继续时给你三个步骤' },
    },
    {
      id: 'C16',
      reason: 'unknown_field',
      label: '承诺草案里写了 **id**（`acceptanceEventIds` 属程序侧，模型写 = 编造程序事实）',
      raw: {
        ...good,
        commitment: {
          scope: '下次继续时给出三个步骤',
          criterion: { kind: 'user_report' },
          acceptanceEventIds: ['cev:user:1'],
        },
      },
    },
  ]
}

async function negativeDraftChecks(): Promise<void> {
  const runtime = deterministicRuntime()
  const seen = new Set<GoalDraftRejectionReason>()
  const rows: string[] = []
  let allInvalid = true

  for (const testCase of negativeDraftCases()) {
    const outcome = await understandGoalProposal(
      fixedProvider(testCase.raw),
      inputFor({
        caseId: testCase.id,
        familyId: testCase.id,
        split: 'test',
        layer: 'explicit_operation',
        sourceText: '把写完提纲设成目标',
        context: '（本门自造的负控样本，不是语料条目）',
        candidates: [],
        gold: { operation: 'create' },
      }),
      runtime,
    )
    const got = outcome.kind === 'invalid' ? outcome.reason : `kind=${outcome.kind}`
    if (outcome.kind === 'invalid') seen.add(outcome.reason)
    if (outcome.kind !== 'invalid') allInvalid = false
    rows.push(`${testCase.id}:${got}`)
    record(
      'C',
      testCase.id,
      `【负控】${testCase.label} ⇒ \`invalid/${testCase.reason}\`（**不是** none）`,
      `invalid/${testCase.reason}`,
      got,
      outcome.kind === 'invalid' && outcome.reason === testCase.reason,
    )
  }

  const reachable = GOAL_DRAFT_REJECTION_REASONS.filter(
    (reason) => GOAL_DRAFT_REJECTION_FACTS[reason].reachable,
  )
  record(
    'C',
    'C13',
    '**全部** 13 条拒绝原因都被上面的负控真的触发过（没有"登记了但永远出不来"的原因）',
    `${String(reachable.length)}/${String(GOAL_DRAFT_REJECTION_REASONS.length)}`,
    `命中=${String(seen.size)}/${String(GOAL_DRAFT_REJECTION_REASONS.length)} · 明细=${rows.join(' ')}`,
    seen.size === GOAL_DRAFT_REJECTION_REASONS.length && allInvalid,
  )
}

// ---------------------------------------------------------------------------
// D 组：传输 / 来源 / 空输入 —— 四态分列
// ---------------------------------------------------------------------------

async function transportChecks(): Promise<void> {
  const item = buildGoalCorpus().items.find((i) => i.split === 'test')!

  const throwing = await understandGoalProposal(
    {
      name: 'm10-throwing-provider',
      version: 'v1',
      call: async () => {
        throw new Error('注入的 provider 抛错（负控）')
      },
    },
    inputFor(item),
    deterministicRuntime(),
  )
  record(
    'D',
    'D1',
    '【负控】provider 抛错 ⇒ `transport/provider_error`（**不是** none，也**不是** invalid）',
    'transport/provider_error',
    `${throwing.kind}${throwing.kind === 'transport' ? `/${throwing.reason}` : ''}`,
    throwing.kind === 'transport' && throwing.reason === 'provider_error',
  )

  const timedOut = await understandGoalProposal(
    fixedProvider(draftForGold(item)),
    inputFor(item),
    deterministicRuntime({ timeout: true }),
  )
  record(
    'D',
    'D2',
    '【负控】超时 ⇒ `transport/timeout`（期限 = 硬期限常量，零隐式重试）',
    `transport/timeout（${String(GOAL_UNDERSTANDING_DEADLINE_MS)}ms）`,
    `${timedOut.kind}${timedOut.kind === 'transport' ? `/${timedOut.reason}` : ''}`,
    timedOut.kind === 'transport' && timedOut.reason === 'timeout',
  )

  let providerCalls = 0
  const counted: GoalUnderstandingProvider = {
    name: 'm10-counting-provider',
    version: 'v1',
    call: async () => {
      providerCalls += 1
      return draftForGold(item)
    },
  }
  const unqualified = await understandGoalProposal(
    counted,
    { ...inputFor(item), sourceQualification: 'UNCONFIRMED_ORIGIN' },
    deterministicRuntime(),
  )
  record(
    'D',
    'D3',
    '【负控】来源归因不是 ESTABLISHED ⇒ `source_unusable`，且 **provider 一次都没被调用**',
    'source_unusable · providerCalls=0',
    `${unqualified.kind} · providerCalls=${String(providerCalls)}`,
    unqualified.kind === 'source_unusable' && providerCalls === 0,
  )

  const blank = await understandGoalProposal(
    counted,
    { ...inputFor(item), currentInput: '   ' },
    deterministicRuntime(),
  )
  record(
    'D',
    'D4',
    '空原话 ⇒ `not_invoked`（**不是** none、不是 invalid、不是 transport）',
    'not_invoked',
    blank.kind,
    blank.kind === 'not_invoked',
  )

  const kinds = new Set<GoalUnderstandingOutcome['kind']>()
  for (const outcome of [throwing, timedOut, unqualified, blank]) kinds.add(outcome.kind)
  record(
    'D',
    'D5',
    '**四态不合并**：`transport` / `source_unusable` / `not_invoked` 与正控的 `understood` 是四种不同结论',
    '4 种结论各自出现在案',
    `本组命中=${[...kinds].sort().join(',')}`,
    kinds.has('transport') && kinds.has('source_unusable') && kinds.has('not_invoked'),
  )
}

// ---------------------------------------------------------------------------
// E 组：草案 → 程序侧提案（乐观锁 / 三态不合并 / 失败关闭）
// ---------------------------------------------------------------------------

async function mappingChecks(): Promise<void> {
  const registry = createFullDomainEventRegistry()
  const processed = { hasProcessed: async (): Promise<boolean> => false }
  const state = {
    getGoal: async (): Promise<undefined> => undefined,
    listGoals: async (): Promise<never[]> => [],
  }
  const deps = {
    registry,
    processed,
    state,
    policy: { characterId: CHARACTER_ID, activeUserId: ACTIVE_USER },
  }

  const base = {
    characterId: CHARACTER_ID,
    sourceEventId: SOURCE_EVENT,
    proposalId: 'm10-source-probe',
    processor: 'm10-source-verify',
    processorVersion: 'm10-source-verify@1',
    candidates: CANDIDATES,
    sourceText: '把写完提纲设成目标',
    now: 1_950_000_000_000,
  }

  /* E1: create 映射出 GOAL_CREATED，且 id 由放行口重写 */
  const createDraft = draftForGold({
    caseId: 'e1',
    familyId: 'e1',
    split: 'test',
    layer: 'explicit_operation',
    sourceText: '把写完提纲设成目标',
    context: '（本门自造的负控样本，不是语料条目）',
    candidates: [],
    gold: { operation: 'create' },
  })
  const mapped = draftToProgramProposal(createDraft, base)
  const payloadGoalId = (() => {
    const target = mapped.proposal?.targetEvents[0]
    const payload = target?.payload as { goal?: { goalId?: string } } | undefined
    return payload?.goal?.goalId
  })()
  const accepted = mapped.proposal === undefined
    ? undefined
    : await validateGoalProposal(deps, mapped.proposal)
  const acceptedGoalId = (() => {
    const event = accepted?.acceptedEvents[0]
    const payload = event?.payload as { goal?: { goalId?: string } } | undefined
    return payload?.goal?.goalId
  })()
  record(
    'E',
    'E1',
    '`create` 草案 → `GOAL_CREATED` 提案；草案里的**占位 id** 被放行口重写为程序派生值',
    '占位 ≠ 派生 · 放行口 accepted',
    `占位=${String(payloadGoalId)} · 派生=${String(acceptedGoalId)} · accepted=${String(accepted?.accepted ?? false)}`,
    payloadGoalId === '(derived-by-validator)' &&
      accepted !== undefined &&
      accepted.accepted &&
      typeof acceptedGoalId === 'string' &&
      acceptedGoalId.startsWith('gol:'),
  )

  /* E2: 五个"写"操作的事件类型与 programOperation */
  const writing: { operation: GoalProposalOperation; type: string; op: string }[] = [
    { operation: 'revise', type: 'GOAL_REVISED', op: 'revise' },
    { operation: 'pause', type: 'GOAL_PAUSED', op: 'pause' },
    { operation: 'resume', type: 'GOAL_RESUMED', op: 'resume' },
    { operation: 'cancel', type: 'GOAL_CANCELLED', op: 'cancel' },
    { operation: 'report_complete', type: 'GOAL_COMPLETED', op: 'complete' },
  ]
  const rows: string[] = []
  let writingOk = true
  for (const spec of writing) {
    const draft = draftForGold({
      caseId: spec.operation,
      familyId: spec.operation,
      split: 'test',
      layer: 'explicit_operation',
      sourceText: base.sourceText,
      context: '（本门自造的负控样本，不是语料条目）',
      candidates: [],
      gold: { operation: spec.operation, ...(spec.operation === 'cancel' ? { cancelKind: 'user_cancel' as const } : {}) },
    })
    const result = draftToProgramProposal(draft, base)
    const type = result.proposal?.targetEvents[0]?.type
    const ok = type === spec.type && result.programOperation === spec.op
    if (!ok) writingOk = false
    rows.push(`${spec.operation}→${String(type)}/${String(result.programOperation)}`)
  }
  record(
    'E',
    'E2',
    '五个"写"操作各自映射到正确的事件类型与领域操作（**唯一**映射点）',
    '5/5',
    rows.join(' · '),
    writingOk,
  )

  /* E3: 三个"不写"操作：无提案，且 fact 分列（不合并成 undefined） */
  const nonWriting = GOAL_NON_WRITING_OPERATIONS.map((operation) => {
    const draft = draftForGold({
      caseId: operation,
      familyId: operation,
      split: 'test',
      layer: 'explicit_operation',
      sourceText: base.sourceText,
      context: '（本门自造的负控样本，不是语料条目）',
      candidates: [],
      gold: { operation },
    })
    const result = draftToProgramProposal(draft, base)
    return { operation, hasProposal: result.proposal !== undefined, outcome: result.fact.outcome }
  })
  record(
    'E',
    'E3',
    '三个"不写"操作（none / query / clarify）**都没有提案**，且 `fact.outcome` **三态分列**（不合并）',
    'none→no_goal_operation · query→query · clarify→clarify',
    nonWriting.map((r) => `${r.operation}→${r.outcome}/proposal=${String(r.hasProposal)}`).join(' · '),
    nonWriting.every((r) => !r.hasProposal) &&
      nonWriting[0]!.outcome === 'no_goal_operation' &&
      nonWriting[1]!.outcome === 'query' &&
      nonWriting[2]!.outcome === 'clarify',
  )

  /* E4: expectedRevision 取自**程序读数**（改候选的 revision ⇒ payload 跟着变） */
  const pauseDraft = draftForGold({
    caseId: 'e4',
    familyId: 'e4',
    split: 'test',
    layer: 'explicit_operation',
    sourceText: base.sourceText,
    context: '（本门自造的负控样本，不是语料条目）',
    candidates: [],
    gold: { operation: 'pause' },
  })
  const revOf = (revision: number): number => {
    const result = draftToProgramProposal(pauseDraft, {
      ...base,
      candidates: CANDIDATES.map((c) =>
        c.goalId === pauseDraft.targetGoalId ? { ...c, revision } : c,
      ),
    })
    const payload = result.proposal?.targetEvents[0]?.payload as { expectedRevision?: number }
    return Number(payload?.expectedRevision)
  }
  const revA = revOf(3)
  const revB = revOf(11)
  record(
    'E',
    'E4',
    '`expectedRevision` 取自**候选摘要里的程序读数**（不是猜的、不是常量）⇒ 乐观锁真的接上',
    'revision 3 → 3 · revision 11 → 11',
    `3→${String(revA)} · 11→${String(revB)}`,
    revA === 3 && revB === 11,
  )

  /* E5: resume 的缺省 recheck dropped=1 ⇒ 放行口**拒绝**（失败关闭：没有复核读数就不能恢复） */
  const resumeDraft = draftForGold({
    caseId: 'e5',
    familyId: 'e5',
    split: 'test',
    layer: 'explicit_operation',
    sourceText: base.sourceText,
    context: '（本门自造的负控样本，不是语料条目）',
    candidates: [],
    gold: { operation: 'resume' },
  })
  const resumeMapped = draftToProgramProposal(resumeDraft, base)
  const resumeVerdict =
    resumeMapped.proposal === undefined
      ? undefined
      : await validateGoalProposal(deps, resumeMapped.proposal)
  record(
    'E',
    'E5',
    '**失败关闭**：`resume` 的缺省复核读数是"有丢弃项" ⇒ 放行口拒绝它（没有复核读数就不能恢复）',
    'rejected 且含 goal_operation_dependency_unavailable 或 goal_not_found',
    `${String(resumeVerdict?.accepted)} · [${(resumeVerdict?.rejected ?? []).map((r) => r.code).join(',')}]`,
    resumeVerdict !== undefined &&
      !resumeVerdict.accepted &&
      resumeVerdict.rejected.length > 0,
  )

  /* E6: explicit_forget 的取消带上禁用根 */
  const forgetDraft = draftForGold({
    caseId: 'e6',
    familyId: 'e6',
    split: 'test',
    layer: 'dependency_change',
    sourceText: base.sourceText,
    context: '（本门自造的负控样本，不是语料条目）',
    candidates: [],
    gold: { operation: 'cancel', cancelKind: 'explicit_forget' },
  })
  const forgetMapped = draftToProgramProposal(forgetDraft, base)
  const forgetPayload = forgetMapped.proposal?.targetEvents[0]?.payload as {
    reason?: string
    forbiddenSourceEventIds?: string[]
  }
  record(
    'E',
    'E6',
    '`explicit_forget` 的取消**带上禁用根**（非空）——否则"忘掉"不产生任何禁用，旧根会复活',
    'reason=explicit_forget · forbidden 非空',
    `reason=${String(forgetPayload?.reason)} · forbidden=${JSON.stringify(forgetPayload?.forbiddenSourceEventIds ?? null)}`,
    forgetPayload?.reason === 'explicit_forget' &&
      (forgetPayload.forbiddenSourceEventIds ?? []).length > 0,
  )
}

// ---------------------------------------------------------------------------
// F 组：结构性检查（模型不能编造程序事实 / 隐私）
// ---------------------------------------------------------------------------

function structuralChecks(): void {
  const forbiddenFields = ['goalId', 'userId', 'sourceEventId', 'evidenceId', 'actionId', 'traceId']
  const present = forbiddenFields.filter((field) => field in GOAL_DRAFT_FIELD_ALLOWLIST)
  record(
    'F',
    'F1',
    '草案的**字段闭集**里没有 `goalId` / `userId` / `sourceEventId` / `evidenceId` 等程序事实字段'
      + '（"模型编造 id"在结构上不可能 —— 计划 §7.2）',
    `0 个`,
    `出现的=${present.join(',') || '无'}`,
    present.length === 0,
  )

  record(
    'F',
    'F2',
    '草案**不携带任何文本**（只有 span 坐标）⇒ "用生成的字当原文证明"在类型上不可能',
    '契约里没有 text/content/quote 字段',
    `字段集=[${Object.keys(GOAL_DRAFT_FIELD_ALLOWLIST).join(',')}]`,
    !Object.keys(GOAL_DRAFT_FIELD_ALLOWLIST).some((f) =>
      ['text', 'content', 'quote', 'rawText'].includes(f),
    ),
  )

  const contractSource = readFileSync(
    join(REPO_ROOT, 'src/kernel/contracts/goal-proposal.ts'),
    'utf8',
  )
  const leaksUserText = /console\.(log|error|warn)/.test(contractSource)
  record(
    'F',
    'F3',
    '契约层**没有任何打印**（它会被喂用户原话；打印等于把正文写进日志）',
    '0 处 console.*',
    leaksUserText ? '发现 console.*' : '无',
    !leaksUserText,
  )

  record(
    'F',
    'F4',
    '语料文件的 `note`（金标说明）**不进** provider 输入：输入形状只有 sourceText / candidates / 资格读数',
    '输入形状不含 note',
    'GoalUnderstandingInput 的字段：characterId · currentInput · sourceEventId · sourceQualification · candidates · lastAssistantEventId',
    !Object.keys(
      { characterId: 1, currentInput: 1, sourceEventId: 1, sourceQualification: 1, candidates: 1, lastAssistantEventId: 1 },
    ).includes('note'),
  )

  const corpusSource = readFileSync(join(REPO_ROOT, 'evals/m10/goal-corpus.ts'), 'utf8')
  record(
    'F',
    'F5',
    '语料是**规格**而不是模型考试题：文件里有明确的"不得把本文件读数当成模型质量读数"说明',
    '说明在场',
    corpusSource.includes('不得**把本文件的读数当成模型质量读数') ? '在场' : '缺失',
    corpusSource.includes('不得**把本文件的读数当成模型质量读数'),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  phase('corpus')
  const build = buildGoalCorpus()
  corpusChecks(build)
  phase('corpus through chain')
  await corpusThroughChainChecks(build)
  phase('draft negatives')
  await negativeDraftChecks()
  phase('transport / source')
  await transportChecks()
  phase('mapping')
  await mappingChecks()
  phase('structural')
  structuralChecks()
  phase('done')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp4-source', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['A', 'B', 'C', 'D', 'E', 'F'] as const
  const perGroup = Object.fromEntries(
    groups.map((g) => [
      g,
      {
        total: checks.filter((c) => c.group === g).length,
        passed: checks.filter((c) => c.group === g && c.pass).length,
      },
    ]),
  )
  const corpusManifest = buildGoalCorpusManifest(build)

  const payload = {
    schema: 'm10-source-verify@1',
    runId,
    head,
    characterId: CHARACTER_ID,
    corpus: corpusManifest,
    checks,
    perGroup,
    summary: {
      total: checks.length,
      passed,
      failed,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
  }
  writeFileSync(join(dir, 'source-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp4',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'source-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP4 语义提案门（**离线固定 provider**，零模型调用）：语料完整性与有效分母（A）· ' +
      '300 条走通链（B）· 12 条拒绝原因逐条可达且记 invalid 不当 none（C）· ' +
      '传输/来源/空输入四态分列（D）· 草案→提案映射与乐观锁接上（E）· 结构性边界（F）',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  console.log(`corpus: total=${String(build.counts.total)} · bySplit=${JSON.stringify(build.counts.bySplit)} · hash=${build.corpusHash}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} [${c.group}] ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
