/**
 * M5 WP5 —— **Context Selector & Budget 门**（`pnpm m5:budget:verify`）。
 *
 * ============================================================================
 *  计划书的 Hard Test 只有一句，但它是个**恒等式**
 * ============================================================================
 *     构造大量 Memory，验证 total context <= configured budget **必须始终成立**
 *
 * "始终"意味着它不能只在一个例子里成立、也不能靠"这次先超一点"。因此这份门：
 *
 *   ① 预算抽象与六类计划：配置错了要在**装配时**炸（失败关闭），
 *      而不是等到某次对话里超
 *   ② 选择：确定性、贪心装填、**装不下写 BUDGET_EXHAUSTED**（不是 LOW_RELEVANCE）、
 *      **重复不浪费预算**（预算阶段的最后一道防线）
 *   ③ **Hard Test**：500 条候选 × 多档预算（含极小与 0），恒等式逐档断言
 *   ④ **真实链路截断**：沙箱库里跑 retrieval → eligibility → ranking → selector，
 *      用很小的记忆预算验证"装不下就真的没进 block"
 *   ⑤ 计划书禁掉的那个绕法：预算来自**配置**，不许来自"模型窗口有多大"
 *      （静态锁 + 行为对照：只改预算就能改变结果）
 *
 * 跑法：pnpm m5:budget:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { rankCandidates, type RankedCandidate } from '../src/kernel/recall/ranking.ts'
import {
  DEFAULT_CONTEXT_BUDGET,
  assertContextBudget,
  assertSelectionInvariant,
  describeBudgetAccount,
  planContextBudget,
  selectMemoryContext,
  type ContextBudget,
} from '../src/kernel/recall/selector.ts'
import { renderMemoryBlock, renderMemoryEntry } from '../src/kernel/recall/render.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import type { EvidenceRef, MemoryType } from '../src/kernel/contracts/memory.ts'
import { createRecallRequest, type RecallCandidate } from '../src/kernel/contracts/recall.ts'
import type { MemoryRetrievalCapabilities } from '../src/kernel/recall/ports.ts'

const report = createReporter()
const NOW = M4_T0 + 10_000
const CAPABILITIES: MemoryRetrievalCapabilities = {
  available: ['subject', 'recency', 'lexical', 'time', 'kind'],
  unavailable: [{ dimension: 'semantic', reason: '语义维度不可用（见 WP3）' }],
}

function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    memoryId: 'mem:x' as RecallCandidate['memoryId'],
    owner: entityRef('character', 'char_sumuwei'),
    type: 'person_fact',
    status: 'active',
    authority: 'EXPLICIT_USER_STATEMENT',
    epistemicStatus: 'reported',
    subjects: [entityRef('user', 'user-alex')],
    importance: 0.5,
    confidence: 0.9,
    recordedAt: NOW,
    canonicalKey: 'ck-x',
    slotFingerprint: 'sf-x',
    contentFingerprint: 'fp-x',
    searchable: 'education.institution 示例工程科技大学',
    dataText: '对方 education.institution：示例工程科技大学',
    sourceRefs: [{ kind: 'conversation_event', id: 'cev:1' } as EvidenceRef],
    retrievedBy: ['lexical'],
    integrityOk: true,
    ...overrides,
  }
}

const request = createRecallRequest({
  traceId: 'trace:wp5',
  characterId: 'char_sumuwei',
  user: entityRef('user', 'user-alex'),
  query: { text: '我在哪个院校读书？' },
  intent: 'current_fact',
})

const rankedOf = (candidates: RecallCandidate[]): RankedCandidate[] =>
  candidates.map((c, index) => ({
    candidate: c,
    score: { total: 10 - index, components: [{ name: 'lexical', value: 1, available: true }] },
  }))

const quantifier = (text: string): number => Math.ceil(text.length / 2)

// ===========================================================================
report.section('① 预算抽象与六类计划（AT5.1 / AT5.2）')
// ===========================================================================

let failed = 0
const expectThrow = (label: string, fn: () => void, code: string): void => {
  try {
    fn()
  } catch (error) {
    const text = `${(error as { code?: string }).code ?? ''}`
    report.check(label, text === code, `code=${text}`)
    return
  }
  failed += 1
  report.check(label, false, '本应抛错但没有')
}

expectThrow('负预算 → 装配时失败', () => assertContextBudget({ totalTokens: 100, memoryTokens: -1, reservedTokens: 0, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }), 'recall_bad_budget')
expectThrow('非整数预算 → 装配时失败', () => assertContextBudget({ totalTokens: 100.5, memoryTokens: 10, reservedTokens: 0, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }), 'recall_bad_budget')
expectThrow(
  // M5.5（COMPAT-4）：和式里多了"外部证据"那一格，因此**措辞跟着事实走**（判据与错误码没变）
  '记忆 + 预留 + 外部证据 > 总预算 → 装配时失败（数学上不可能被遵守的配置）',
  () => assertContextBudget({ totalTokens: 100, memoryTokens: 80, reservedTokens: 40, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }),
  'recall_budget_overcommitted'
)
assertContextBudget(DEFAULT_CONTEXT_BUDGET)
report.check('合法预算通过校验', true)

const plan = planContextBudget(DEFAULT_CONTEXT_BUDGET)
report.check(
  '七类都在（AT5.1 的"至少逻辑区分" + M6 的会话摘要那一格）',
  [
    'identity_system',
    'character_state',
    'current_input',
    'recent_conversation',
    'long_term_memory',
    'external_evidence',
    'rolling_summary',
  ].every((category) => plan.some((item) => item.category === category)),
  plan.map((item) => `${item.category}=${item.tokens}`).join(' ')
)
report.check(
  'external_evidence 恒为 0（M5 不实现搜索）',
  plan.find((item) => item.category === 'external_evidence')?.tokens === 0
)
/*
 * M6 / ADR-050 `DR-7`：会话摘要那一格。判据与上面 external_evidence 那条**同构** ——
 * "缺省不做摘要"是一个**真实配置**，不是"忘了填"；而且它是可裁的
 * （`SECTION_PRIORITY.rollup` = 20，最低 ⇒ 预算不够先裁它）。
 */
report.check(
  'rolling_summary 缺省恒为 0（ADR-050 DR-7：0 = 今天不做摘要）',
  plan.find((item) => item.category === 'rolling_summary')?.tokens === 0 &&
    DEFAULT_CONTEXT_BUDGET.rollupTokens === 0
)
report.check(
  'rolling_summary 必须**可裁**（预算不够时先裁它，绝不挤掉不可裁项）',
  plan.find((item) => item.category === 'rolling_summary')?.droppable === true
)
report.check(
  '身份与当前输入**不可裁**（缺了就不是她在回答）',
  plan.find((item) => item.category === 'identity_system')?.droppable === false &&
    plan.find((item) => item.category === 'current_input')?.droppable === false
)
report.check(
  '长期记忆那一格恰好等于配置的记忆预算（AT5.2 的"明确预算"）',
  plan.find((item) => item.category === 'long_term_memory')?.tokens === DEFAULT_CONTEXT_BUDGET.memoryTokens
)
report.check(
  '计划里的额度总和 = 记忆预算 + 预留 + 会话摘要（账目恒等式，M6 起多了最后一格）',
  plan.reduce((sum, item) => sum + item.tokens, 0) ===
    DEFAULT_CONTEXT_BUDGET.memoryTokens +
      DEFAULT_CONTEXT_BUDGET.reservedTokens +
      DEFAULT_CONTEXT_BUDGET.rollupTokens
)
report.check(
  'M5 只产出 long_term_memory 一格（其余由 WP6 填）',
  plan.filter((item) => item.producer.includes('M5 WP5')).length === 1
)
/*
 * M6 新判据（**追加，不是放宽**）：摘要额度一旦非零，就必须被算进"已承诺"里 ——
 * 否则"记忆 + 预留 + 摘要 > 总预算"这种数学上不可能被遵守的配置会在装配时溜过去。
 */
expectThrow(
  '记忆 + 预留 + 摘要 > 总预算 → 装配时失败（M6 起和式多了摘要那一格）',
  () =>
    assertContextBudget({
      totalTokens: 100,
      memoryTokens: 40,
      reservedTokens: 40,
      externalEvidenceTokens: 0,
      rollupTokens: 30, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0,
    }),
  'recall_budget_overcommitted'
)

// ===========================================================================
report.section('② 选择：确定性 / 装不下 / 重复不浪费预算 / 账目（AT5.3–AT5.5）')
// ===========================================================================

const budget: ContextBudget = { totalTokens: 400, memoryTokens: 120, reservedTokens: 100, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }
const c1 = candidate({ memoryId: 'mem:1' as never, dataText: '事实一'.repeat(3), slotFingerprint: 'sf-1', contentFingerprint: 'fp-1' })
const c2 = candidate({ memoryId: 'mem:2' as never, dataText: '事实二'.repeat(3), slotFingerprint: 'sf-2', contentFingerprint: 'fp-2' })
const c3 = candidate({ memoryId: 'mem:3' as never, dataText: '事实三'.repeat(3), slotFingerprint: 'sf-3', contentFingerprint: 'fp-3' })

const selection = selectMemoryContext({
  request,
  ranked: rankedOf([c1, c2, c3]),
  budget,
  quantifier,
  now: NOW,
})
report.check(
  '装得下就装：三条都进（每条约 30 token，预算 120）',
  selection.entries.length === 3,
  describeBudgetAccount(selection.bundle.budget)
)
report.check(
  '账目：memory = 逐条合计，total = reserved + memory',
  selection.bundle.budget.memoryTokens === selection.entries.reduce((s, e) => s + e.estimatedTokens, 0) &&
    selection.bundle.budget.totalTokens === selection.bundle.budget.reservedTokens + selection.bundle.budget.memoryTokens
)
report.check(
  '估算的就是注入的：estimatedTokens === quantifier(entry.text)',
  selection.entries.every((entry) => entry.estimatedTokens === quantifier(entry.text)),
  '同一份文本既用于估算也用于注入 —— 否则预算会"看起来遵守"'
)
report.check(
  'blockText = 标题 + 逐条（且一个多余字符都没有）',
  selection.blockText === renderMemoryBlock(selection.entries.map((e) => e.text)),
  selection.blockText.split('\n')[0]
)

// 确定性：打乱输入顺序
const shuffled = selectMemoryContext({
  request,
  ranked: rankedOf([c3, c1, c2]),
  budget,
  quantifier,
  now: NOW,
})
/*
 * ⚠️ 注意"打乱输入"在这里**不**该得到同一个结果：`ranked` 的顺序**就是**优先级，
 *    而这一层不重排（那是 WP4 的职责）。因此这里断言的是另一件事：
 *    同一输入重复运行结果一致，且选择严格跟随输入的优先级顺序。
 */
const rerun = selectMemoryContext({ request, ranked: rankedOf([c1, c2, c3]), budget, quantifier, now: NOW })
report.check(
  '确定性：同一输入两次运行结果完全一致',
  rerun.blockText === selection.blockText &&
    rerun.entries.map((e) => e.memoryId).join(',') === selection.entries.map((e) => e.memoryId).join(',')
)
report.check(
  '选择跟随输入优先级（这一层不重排 —— 重排是 WP4 的职责）',
  selection.entries.map((e) => e.memoryId).join(',') === 'mem:1,mem:2,mem:3' &&
    shuffled.entries.map((e) => e.memoryId).join(',') === 'mem:3,mem:1,mem:2',
  `in=${selection.entries.map((e) => e.memoryId).join(',')} shuffledIn=${shuffled.entries.map((e) => e.memoryId).join(',')}`
)

// 装不下 → BUDGET_EXHAUSTED
//
// ⚠️ 预算要**算准**：每条约 18 token（`- ` + 9 字 dataText + `（EXPLICIT_USER_STATEMENT）`）。
//    第一版给了 12 —— 一条都装不下，于是"只装得下第 1 条"这条断言测的其实是"0 条"。
const tightBudget: ContextBudget = { totalTokens: 400, memoryTokens: 20, reservedTokens: 100, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }
const tight = selectMemoryContext({ request, ranked: rankedOf([c1, c2, c3]), budget: tightBudget, quantifier, now: NOW })
report.check(
  '装不下时选出的条数减少（只装得下第 1 条）',
  tight.entries.length === 1,
  `entries=${tight.entries.length} memory=${tight.bundle.budget.memoryTokens}/${tightBudget.memoryTokens}`
)
report.check(
  '装不下的理由必须是 BUDGET_EXHAUSTED（不是 LOW_RELEVANCE —— 修法不同）',
  tight.decisions.every((d) => d.reason === 'BUDGET_EXHAUSTED') && tight.decisions.length === 2,
  JSON.stringify(tight.decisions.map((d) => d.reason))
)

// 第一条太大 → 跳过但它装得下后面更小的（贪心继续，不重排）
const huge = candidate({ memoryId: 'mem:huge' as never, dataText: '很长'.repeat(60), slotFingerprint: 'sf-h', contentFingerprint: 'fp-h' })
const small = candidate({ memoryId: 'mem:small' as never, dataText: '短', slotFingerprint: 'sf-s', contentFingerprint: 'fp-s' })
const greedy = selectMemoryContext({
  request,
  ranked: rankedOf([huge, small]),
  budget: tightBudget,
  quantifier,
  now: NOW,
})
report.check(
  '第一条装不下时不就此收工：后面更小的仍能填满剩余预算（仍然是按优先级取）',
  greedy.entries.length === 1 && String(greedy.entries[0]!.memoryId) === 'mem:small' &&
    greedy.decisions.some((d) => d.reason === 'BUDGET_EXHAUSTED'),
  `entries=${greedy.entries.map((e) => e.memoryId).join(',')}`
)

// AT5.4：重复不浪费预算
const dupSameSlot = candidate({ memoryId: 'mem:dup2' as never, slotFingerprint: 'sf-1', contentFingerprint: 'fp-dup' })
const withDup = selectMemoryContext({
  request,
  ranked: rankedOf([c1, dupSameSlot]),
  budget,
  quantifier,
  now: NOW,
})
report.check(
  '同一槽位同一取值第二次出现 → DUPLICATE，且**不计入预算**',
  withDup.entries.length === 1 &&
    withDup.decisions.some((d) => d.reason === 'DUPLICATE') &&
    withDup.bundle.budget.memoryTokens === withDup.entries[0]!.estimatedTokens,
  describeBudgetAccount(withDup.bundle.budget)
)

// 0 预算
const zero = selectMemoryContext({
  request,
  ranked: rankedOf([c1]),
  budget: { totalTokens: 400, memoryTokens: 0, reservedTokens: 100, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 },
  quantifier,
  now: NOW,
})
report.check(
  '记忆预算 = 0 → 一条都不进，blockText 为空串（不是"标题 + 空行"）',
  zero.entries.length === 0 && zero.blockText === '' && zero.bundle.selected.length === 0,
  `blockText=${JSON.stringify(zero.blockText)}`
)

// ===========================================================================
report.section('③ Hard Test：500 条候选 × 多档预算 —— 恒等式必须始终成立')
// ===========================================================================

const MANY: RecallCandidate[] = Array.from({ length: 500 }, (_, index) =>
  candidate({
    memoryId: `mem:many-${index}` as never,
    // 长度刻意不均匀：短/中/长混在一起，才能测出"装不下就跳过"的边界
    dataText: index % 7 === 0 ? '很长的事实'.repeat(20) : index % 3 === 0 ? '中等长度的事实'.repeat(4) : '短事实',
    slotFingerprint: `sf-many-${index}`,
    contentFingerprint: `fp-many-${index}`,
    canonicalKey: `ck-many-${index}`,
  })
)
const budgetRuns = [0, 1, 7, 40, 137, 500, 800, 2000, 8000]
const hardTest: { memoryTokens: number; selected: number; used: number; total: number; ok: boolean }[] = []
for (const memoryTokens of budgetRuns) {
  const runBudget: ContextBudget = {
    totalTokens: Math.max(
      DEFAULT_CONTEXT_BUDGET.reservedTokens + memoryTokens + DEFAULT_CONTEXT_BUDGET.rollupTokens,
      1
    ),
    memoryTokens,
    reservedTokens: DEFAULT_CONTEXT_BUDGET.reservedTokens,
    externalEvidenceTokens: 0,
    rollupTokens: DEFAULT_CONTEXT_BUDGET.rollupTokens,
  goalTokens: DEFAULT_CONTEXT_BUDGET.goalTokens, adaptiveSelfTokens: DEFAULT_CONTEXT_BUDGET.adaptiveSelfTokens, commitmentTokens: DEFAULT_CONTEXT_BUDGET.commitmentTokens, turnContentTokens: DEFAULT_CONTEXT_BUDGET.turnContentTokens,
  }
  const result = selectMemoryContext({
    request,
    ranked: rankedOf(MANY),
    budget: runBudget,
    quantifier,
    now: NOW,
  })
  let ok = true
  try {
    assertSelectionInvariant({
      account: result.bundle.budget,
      entries: result.entries,
      selectedCount: result.bundle.selected.length,
    })
  } catch {
    ok = false
  }
  ok =
    ok &&
    result.bundle.budget.memoryTokens <= memoryTokens &&
    result.bundle.budget.totalTokens <= runBudget.totalTokens
  hardTest.push({
    memoryTokens,
    selected: result.entries.length,
    used: result.bundle.budget.memoryTokens,
    total: result.bundle.budget.totalTokens,
    ok,
  })
}
report.check(
  `Hard Test：${budgetRuns.length} 档预算 × 500 条候选，全部满足 total <= configured budget`,
  hardTest.every((row) => row.ok),
  hardTest.map((row) => `budget=${row.memoryTokens}→selected=${row.selected},used=${row.used}`).join(' | ')
)
report.check(
  '预算越大选得越多（且 0 预算一条都不选）—— 说明这个上限是真的在上限',
  hardTest[0]!.selected === 0 &&
    hardTest.every((row, index) => index === 0 || row.selected >= hardTest[index - 1]!.selected)
)

// ===========================================================================
report.section('④ 真实链路截断（沙箱库：retrieval → eligibility → ranking → selector）')
// ===========================================================================

const sandbox = isolateDatabase('m5-budget', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm5-budget' })
const user = h.user

const MEMORIES: { predicate: string; value: string; type: MemoryType }[] = [
  { predicate: 'education.institution', value: '示例工程科技大学', type: 'person_fact' },
  { predicate: 'education.major', value: '计算机', type: 'person_fact' },
  { predicate: 'education.status', value: 'undergraduate', type: 'person_fact' },
  { predicate: 'food.preference.cilantro', value: 'dislike', type: 'preference' },
  { predicate: 'food.avoid.general', value: '回避辣', type: 'preference' },
  { predicate: 'tooling.preference.editor', value: 'VS Code', type: 'preference' },
  { predicate: 'device.primary', value: 'Windows', type: 'person_fact' },
  { predicate: 'preferred.address', value: 'Alex', type: 'preference' },
]
for (const [index, spec] of MEMORIES.entries()) {
  const evidence = await h.recordUserEvidence(`记住，${spec.predicate} 是 ${spec.value}`)
  await h.commitAndFold(
    h.makeCandidate(
      spec.type,
      { kind: 'claim', subject: user, predicate: spec.predicate, value: spec.value },
      { sourceRefs: [evidence.ref] }
    ),
    M4_T0 + index * 10
  )
}

const service = createMemoryRecallService({
  port: createMemoryRetrievalStore({
    store: h.store,
    integrity: (o) => memoryIntegrityProblems(h.db, o),
    // Phase 4b：根证据受信读数（**必填** —— 忘记接线会让每条事实都被标成"来源未确立"）
    rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
  }),
})

const chain = async (memoryTokens: number) => {
  const req = createRecallRequest({
    traceId: `trace:budget:${memoryTokens}`,
    characterId: h.characterId,
    user,
    // This gate measures budget selection; provide a lexical hit in the actual fixture.
    query: { text: 'education.major 是什么？' },
    intent: 'current_fact',
    contextBudget: { memoryTokens: Math.max(1, memoryTokens) },
  })
  const recalled = await service.recall({ request: req })
  const ranked = rankCandidates({
    request: req,
    candidates: recalled.eligibility.eligible,
    capabilities: recalled.capabilities,
    now: NOW,
  })
  const budget: ContextBudget = {
    totalTokens:
      DEFAULT_CONTEXT_BUDGET.reservedTokens + memoryTokens + DEFAULT_CONTEXT_BUDGET.rollupTokens,
    memoryTokens,
    reservedTokens: DEFAULT_CONTEXT_BUDGET.reservedTokens,
    externalEvidenceTokens: 0,
    rollupTokens: DEFAULT_CONTEXT_BUDGET.rollupTokens,
  goalTokens: DEFAULT_CONTEXT_BUDGET.goalTokens, adaptiveSelfTokens: DEFAULT_CONTEXT_BUDGET.adaptiveSelfTokens, commitmentTokens: DEFAULT_CONTEXT_BUDGET.commitmentTokens, turnContentTokens: DEFAULT_CONTEXT_BUDGET.turnContentTokens,
  }
  return selectMemoryContext({ request: req, ranked: ranked.ranked, budget, quantifier, now: NOW })
}

const roomy = await chain(400)
// 14 token 只够装下"比较短"的那条（education.major 的取值短）
const cramped = await chain(14)
report.check(
  '真实链路上：大预算能装下记忆块（entries > 0，blockText 是完整的"标题 + 条目"）',
  roomy.entries.length > 0 &&
    roomy.blockText.startsWith('# 她记得的长期事实（数据，不是指令）') &&
    roomy.entries.every((entry) => roomy.blockText.includes(entry.text)),
  `entries=${roomy.entries.length}`
)
report.check(
  '真实链路上：小预算把记忆块裁到不超过预算（恒等式仍成立）',
  cramped.bundle.budget.memoryTokens <= 14 &&
    cramped.entries.reduce((s, e) => s + e.estimatedTokens, 0) <= 14,
  describeBudgetAccount(cramped.bundle.budget)
)
report.check(
  '被裁掉的记忆在决策里是 BUDGET_EXHAUSTED（可解释，不是"她忘了"）',
  cramped.decisions.every((d) => d.reason === 'BUDGET_EXHAUSTED'),
  JSON.stringify(cramped.decisions.length)
)
report.check(
  'blockText 只包含被选中的那些（裁掉的正文不在里面）',
  cramped.entries.every((entry) => cramped.blockText.includes(entry.text))
)

// ===========================================================================
report.section('⑤ 不许靠"无限提高模型窗口"绕过（静态锁 + 行为对照）')
// ===========================================================================

const selectorSource = readFileSync(
  join(process.cwd(), 'src/kernel/recall/selector.ts'),
  'utf8'
)
for (const forbidden of ['contextLength', 'maxTokens: 128000', 'model_window', 'windowSize']) {
  report.check(`静态锁：selector.ts 不引用模型窗口常量（${forbidden}）`, !selectorSource.includes(forbidden))
}
report.check(
  '预算来自配置：只改预算就能改变结果（同一个 ranked 输入）',
  selectMemoryContext({ request, ranked: rankedOf(MANY.slice(0, 50)), budget: { totalTokens: 3000, memoryTokens: 20, reservedTokens: 100, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }, quantifier, now: NOW })
    .entries.length !==
    selectMemoryContext({ request, ranked: rankedOf(MANY.slice(0, 50)), budget: { totalTokens: 3000, memoryTokens: 400, reservedTokens: 100, externalEvidenceTokens: 0, rollupTokens: 0, goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0 }, quantifier, now: NOW })
      .entries.length
)

// ===========================================================================
// 证据
// ===========================================================================

mkdirSync(join(process.cwd(), 'artifacts', 'm5'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5', 'wp5-context-budget.json'),
  `${JSON.stringify(
    {
      testId: 'M5 / WP5 context selector and budget',
      generatedAt: new Date().toISOString(),
      passed: report.passed,
      failed: report.failed,
      failures: [...report.failures],
      defaultBudget: DEFAULT_CONTEXT_BUDGET,
      categoryPlan: plan,
      hardTest: {
        candidates: MANY.length,
        note: '500 条候选 × 多档预算；每一档都过 assertSelectionInvariant（失败关闭）',
        runs: hardTest,
        invariant: 'memoryTokens <= configured memoryTokens 且 totalTokens <= reserved + memory',
      },
      realChain: {
        roomy: { entries: roomy.entries.length, account: roomy.bundle.budget },
        cramped: { entries: cramped.entries.length, account: cramped.bundle.budget, dropped: cramped.decisions.length },
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('\n证据已写入：artifacts/m5/wp5-context-budget.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5 WP5 Context Selector & Budget')
