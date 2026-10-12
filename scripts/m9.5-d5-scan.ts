/**
 * M9.5 / `D-5` —— **词面权重扫描器**（对抗验收集 `@3`）
 *
 * ============================================================================
 *  它**必须**驱动系统自己的排序与选择，不许自己算分
 * ============================================================================
 * ```text
 * 理由（本仓库最贵的那条教训）：若扫描器自己算分，那门量的是**我的实现**，
 * 而 `D-5` 的全部主张是"**系统**在对抗场景下选对了"。
 * ⇒ 因此全部走 `hybrid-candidates.ts` 的系统函数：
 *      selectCandidates（merge → order → truncate，**顺序固定**）
 *   —— 连截断都用系统的，不用 `.slice()` 近似。
 *
 * ⚠️ **判定看 `truncation.kept` 的 memoryId**（用户当轮逐字要求：观察截断后的**实际选择**，
 *    不是排序分数组）。
 * ⚠️ 扫描**只**覆盖 `weights.lexical`；`semantic` 与 `margin` 从 `PROVISIONAL_HYBRID_POLICY`
 *    读出来，**不自己写死**（写死会与系统策略各自漂移 ⇒ 又是"量错对象"）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PROVISIONAL_HYBRID_POLICY,
  selectCandidates,
  type ChannelHit,
  type HybridRelevancePolicy,
  type OrderableCandidate,
} from '../src/kernel/app/recall/hybrid-candidates.ts'
import { lexicalFragments, lexicalOverlapStrength } from '../src/kernel/app/memory/target-resolver.ts'

interface Candidate {
  readonly id: string
  /** `@5` 起**不声明**强度 —— 由**真实函数现算**（`@4` 及以前才写在这里） */
  readonly lexical?: number
  readonly text: string
  readonly semantic: number
}
interface Scenario {
  readonly id: string
  readonly name: string
  /** ★ 强度**现算**要它（`@5` 起）：`lexicalOverlapStrength(query, 候选)` */
  readonly query: string
  readonly candidateLimit: number
  readonly candidates: readonly Candidate[]
  readonly expectation: {
    readonly mustSelect: readonly string[]
    readonly mustNotSelect?: readonly string[]
  }
}
interface Corpus {
  readonly corpusVersion: string
  readonly scenarios: readonly Scenario[]
  readonly candidateWeights: readonly number[]
}

const REPO_ROOT = process.cwd()
const corpus = JSON.parse(
  readFileSync(join(REPO_ROOT, 'evals', 'm9.5', 'd5-adversarial', 'corpus.json'), 'utf8')
) as Corpus

/**
 * ⚠️ **假设性对照**（**不是系统**）：用 **3 字**片段跑同一个 `(戊)` 公式。
 *
 * ```text
 * 目的：回答"**改片段粒度**能不能解决 A5 的区分度问题" —— 在**动 `lexicalFragments` 之前**先量。
 * 它**不**驱动判定（判定仍用系统的 `strengthOf`）；只打出来供决策，**不得**当读数用。
 * ```
 */
function hypotheticalTrigramStrength(query: string, text: string): number {
  const chars = [...query]
  const grams = chars.length < 3 ? [] : chars.slice(0, -2).map((_, index) => chars.slice(index, index + 3).join(''))
  if (grams.length === 0) return 0
  const haystack = text.toLowerCase()
  const matched = grams.filter((gram) => haystack.includes(gram))
  if (matched.length === 0) return 0
  return Math.max(...matched.map((gram) => gram.length)) / Math.max(...grams.map((gram) => gram.length))
}

/**
 * ★ **词面强度由系统现算**（`@5` 起）：不读语料里的字段，调**真实函数**。
 *
 * ```text
 * 候选文本包成一条 claim 记录 —— `relevanceHaystack` 读的就是 `content.value`（`target-resolver.ts:294-319`）
 * 选项 `includeRegistrySurfaceForms: false` ⇒ 只依据记录自己的内容（与判别器同口径）
 * ```
 * ⚠️ 这才让读数**关于系统**，而不是关于语料里写着的数字（`ADR-083` §0 ⑥ 的要求）。
 */
function strengthOf(scenario: Scenario, candidate: Candidate): number {
  if (candidate.lexical !== undefined) return candidate.lexical
  return lexicalOverlapStrength(
    scenario.query,
    { content: { kind: 'claim', predicate: 'probe.slot', value: candidate.text } } as never,
    { includeRegistrySurfaceForms: false }
  )
}

/** 跑一个场景 + 一个权重 ⇒ 返回**截断后实际被选中的 memoryId**（全部走系统函数） */
function runScenario(scenario: Scenario, lexicalWeight: number): readonly string[] {
  const hybridPolicy: HybridRelevancePolicy = {
    ...PROVISIONAL_HYBRID_POLICY,
    weights: { ...PROVISIONAL_HYBRID_POLICY.weights, lexical: lexicalWeight },
  }
  const hits: ChannelHit[] = scenario.candidates.flatMap((candidate) => [
    { memoryId: candidate.id, channel: 'lexical' as const, score: strengthOf(scenario, candidate) },
    { memoryId: candidate.id, channel: 'semantic' as const, score: candidate.semantic },
  ])
  const orderables: OrderableCandidate[] = scenario.candidates.map((candidate) => ({
    memoryId: candidate.id,
    recency: 0,
    lexical: strengthOf(scenario, candidate),
    semantic: candidate.semantic,
  }))
  const { truncation } = selectCandidates({
    hits,
    orderables,
    policyVersion: 'hybrid-relevance@1',
    limit: scenario.candidateLimit,
    hybridPolicy,
  })
  return truncation.kept.map((kept) => kept.memoryId)
}

function verdictOf(scenario: Scenario, selected: readonly string[]): { ok: boolean; why: string } {
  const missing = scenario.expectation.mustSelect.filter((id) => !selected.includes(id))
  const forbidden = (scenario.expectation.mustNotSelect ?? []).filter((id) => selected.includes(id))
  if (missing.length > 0) return { ok: false, why: `缺 mustSelect：${missing.join(',')}` }
  if (forbidden.length > 0) return { ok: false, why: `混入 mustNotSelect：${forbidden.join(',')}` }
  return { ok: true, why: '' }
}

const lines: string[] = []
lines.push(`M9.5 / D-5 词面权重扫描（语料 ${corpus.corpusVersion}）`)
lines.push(`  只改 weights.lexical；semantic=${String(PROVISIONAL_HYBRID_POLICY.weights.semantic)} margin=${String(PROVISIONAL_HYBRID_POLICY.weights.margin)} 不动`)
lines.push(`  判定看**截断后的实际选择**（truncation.kept），不是分数`)
lines.push('')

const passing: number[] = []
for (const weight of corpus.candidateWeights) {
  let allOk = true
  lines.push(`── w_lexical = ${String(weight)} ──`)
  for (const scenario of corpus.scenarios) {
    const selected = runScenario(scenario, weight)
    const verdict = verdictOf(scenario, selected)
    if (!verdict.ok) allOk = false
    lines.push(
      `   ${verdict.ok ? '✅' : '❌'} ${scenario.id} limit=${String(scenario.candidateLimit)}` +
        ` 选中=[${selected.join(',')}] 期望=${JSON.stringify(scenario.expectation.mustSelect)}` +
        (verdict.ok ? '' : `  ← ${verdict.why}`)
    )
    /* ★ 把**现算的强度**打出来（`@5` 起）：否则"为什么选错"看不出来 */
    lines.push(
      `      词面强度（现算）：${scenario.candidates
        .map((candidate) => `${candidate.id}=${strengthOf(scenario, candidate).toFixed(3)}`)
        .join(' ')}`
    )
    /* ★ 连**片段**一起打：改强度定义之前必须看清查询被切成了什么（不许猜） */
    lines.push(
      `      查询片段：${JSON.stringify(lexicalFragments(scenario.query))} · ` +
        `目标片段命中情况：${JSON.stringify(
          scenario.candidates.map((candidate) => {
            const fragments = lexicalFragments(scenario.query)
            const haystack = candidate.text.toLowerCase()
            return `${candidate.id}:${fragments.filter((f: string) => haystack.includes(f)).length}/${fragments.length}`
          })
        )}`
    )
    /* ⚠️ **假设性对照**（3 字片段）—— 只供决策，**不**参与判定，**不得**当读数用 */
    lines.push(
      `      ⚠️ 假设对照（3 字片段 · **不是系统**）：${scenario.candidates
        .map((candidate) => `${candidate.id}=${hypotheticalTrigramStrength(scenario.query, candidate.text).toFixed(3)}`)
        .join(' ')}`
    )
  }
  lines.push(`   ⇒ ${allOk ? '全部满足' : '未全部满足'}`)
  lines.push('')
  if (allOk) passing.push(weight)
}

lines.push('='.repeat(72))
if (passing.length === 0) {
  lines.push('结论：**候选集里没有任何值同时满足全部场景** ⇒ 按冻结规则：**不冻结任何值**，')
  lines.push('      如实回报"该方向不足以达标"，并回到用户。**不是**继续调数字。')
} else {
  const smallest = Math.min(...passing)
  lines.push(`结论：满足全部场景的**最小值** = **${String(smallest)}** ⇒ 冻结它（不取更大的）`)
}
lines.push('='.repeat(72))
process.stdout.write(`${lines.join('\n')}\n`)
if (passing.length === 0) process.exitCode = 3
