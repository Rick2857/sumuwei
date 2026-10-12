/**
 * S8 / **`L-S8-31` 方案 A 的 A/B 对照**（`pnpm postlv2:s8:quote:ab:live`）。
 *
 * ============================================================================
 *  它量什么（**真模型**）
 * ============================================================================
 * 方案 A 的**主张**是："强制逐字引用挡掉的是'**脱离用户原话**去选'那一类失败"。
 * 本门用**同一批输入**跑两臂，只有 prompt 与解析规则不同：
 *
 * ```text
 * 臂 1（变更前，`82e14d10` 的规则）：prompt **不**要求 quote；解析只判 schemaVersion /
 *                                   字段闭集 / choiceId 闭集
 * 臂 2（生产，方案 A）：prompt 要求 quote；解析**另加机械包含检查**（quote ⊆ 本轮用户原话）
 * ```
 *
 * 读数（**分列**，不合成一个"效果分"）：
 * ```text
 * ① 假阳（`gold: no_choice` 却给出一个**可提交**的 choiceId）—— 两臂各一个数（**主读数**）
 * ② 真阳（`gold: choice` 且 choiceId 与金标一致）—— 两臂各一个数（**正控**：压假阳不许把好路径砍掉）
 * ③ 臂 2 的拒收码分解（没给引用 / 引用不在原话里 / 弃权）—— **为什么**它更低
 * ```
 *
 * ⚠️ **判据（**先注册**、事后不改）**：`PASS` ⟺ 两臂各自的读数都取到 ≥1 个样本（分母非零），
 *    且 **假阳(臂2) < 假阳(臂1)**，且 **真阳(臂2) ≥ 真阳(臂1)**。
 *    ⇒ 若臂 1 的假阳本来就是 0（天花板），判据**无法**成立 ⇒ 本门如实报 **NO MEASURABLE EFFECT**，
 *      而不是把"没有变化"读成"通过"。
 *
 * ============================================================================
 *  守卫（**绝不回落生产 key**）
 * ============================================================================
 * 缺 `DSH_TEST_MODEL_WRAPPER=1` 或 `OPENAI_API_KEY` ⇒ **拒跑 exit 2**。
 * 用法：`pnpm with-test-model pnpm postlv2:s8:quote:ab:live`
 *
 * ⚠️ **本门不主张什么**：它量的是**草稿层**（方案 A 作用的正是那一层）；
 *    "草稿通过 ⇒ 真的落账本"由 `postlv2:s8:entry-lock:verify` 的 `L1` 单独证明（本门不重复驱动世界）。
 *    它也**不**回答"引用得对不对"（引用得对不对需要语义判定，见 `L-S8-31` 的边界）。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())
const CORPUS = join(REPO_ROOT, 'evals', 'post-lv2', 's8-choice-quote', 'cases.json')
const ROUNDS = 3

/* ---- 守卫：缺包装器标记或测试凭证 ⇒ 拒跑（exit 2），**不**回落生产 key ---- */
if (process.env.DSH_TEST_MODEL_WRAPPER !== '1' || (process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error(
    '❌ 真实批次必须经 `pnpm with-test-model`（缺 DSH_TEST_MODEL_WRAPPER=1 或 OPENAI_API_KEY）—— ' +
      '本门**没有**生产凭证回落。'
  )
  process.exit(2)
}

const { buildStoryChoiceInput, buildStoryChoiceUserMessage } = await import(
  '../src/kernel/app/storyline/choice-input.ts'
)
const { recognizeStoryChoiceDraft } = await import(
  '../src/kernel/contracts/story-choice-draft.ts'
)
const { createOpenAiStoryChoicePort } = await import(
  '../src/infrastructure/model/openai-story-choice.ts'
)
const { JICHUANG_PACK } = await import(
  '../src/content/storyline/jichuang-interview-two/story-pack.ts'
)

interface Case {
  readonly id: string
  readonly gold: 'no_choice' | 'choice'
  readonly currentInput: string
  readonly expectedChoiceId?: string
}
interface Corpus {
  readonly schema: string
  readonly nodeId: string
  readonly candidates: readonly string[]
  readonly recentLines: readonly string[]
  readonly cases: readonly Case[]
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as Corpus
const node = JICHUANG_PACK.nodes.find((candidate) => candidate.id === corpus.nodeId)
if (node === undefined) throw new Error(`语料里的节点 ${corpus.nodeId} 不在内容包里`)

/** 两臂共用的有界输入（**同一批输入**是这条对照的前提） */
const built = corpus.cases.map((item) => {
  const result = buildStoryChoiceInput({
    runId: 's8-quote-ab',
    currentNodeId: node.id,
    stage: String(node.stage),
    revision: 1,
    narrative: '',
    nodeChoices: node.choices,
    currentInput: item.currentInput,
    recentLines: corpus.recentLines,
  })
  if (!result.ok) throw new Error(`语料 ${item.id} 造不出输入：${result.detail}`)
  return { item, input: result.input }
})

/**
 * **臂 1 的解析规则**：变更前（`82e14d10`）那一版 —— 逐字复刻，**没有** quote 相关的三条检查。
 * ⚠️ 它是"当时的生产规则"，不是"我临时放宽的规则"：那一版的 `ALLOWED_FIELDS` 只有
 *    `schemaVersion` / `choiceId`，`choiceId` 非 null 时只判闭集。
 */
const recognizePreQuote = (
  raw: unknown,
  candidates: readonly string[],
): { ok: true; choiceId: string | null } | { ok: false; code: string } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, code: 'not_an_object' }
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== 'story-choice-draft@1') return { ok: false, code: 'schema_version_missing_or_unknown' }
  const extra = Object.keys(record).filter((key) => !['schemaVersion', 'choiceId'].includes(key))
  if (extra.length > 0) return { ok: false, code: 'unknown_field' }
  const value = record.choiceId
  if (value === null) return { ok: true, choiceId: null }
  if (typeof value !== 'string') return { ok: false, code: 'choice_id_not_a_string_or_null' }
  if (value.trim() === '') return { ok: false, code: 'choice_id_empty' }
  if (!candidates.includes(value)) return { ok: false, code: 'choice_id_not_on_frontier' }
  return { ok: true, choiceId: value }
}

const port = createOpenAiStoryChoicePort({})
const candidates = corpus.candidates

interface Outcome {
  readonly caseId: string
  readonly arm: 'pre' | 'post'
  readonly round: number
  readonly kind: 'committable' | 'abstained' | 'rejected' | 'failed'
  readonly choiceId?: string
  readonly code?: string
}
const outcomes: Outcome[] = []
let calls = 0

const runOne = async (
  build: 'pre' | 'post',
  item: Case,
  input: Parameters<typeof buildStoryChoiceUserMessage>[0],
  round: number,
): Promise<void> => {
  const userMessage = buildStoryChoiceUserMessage(input, { requireQuote: build === 'post' })
  let raw: unknown
  calls += 1
  try {
    raw = await port.call({ userMessage, deadlineMs: 20_000 })
  } catch (error) {
    outcomes.push({ caseId: item.id, arm: build, round, kind: 'failed', code: String(error) })
    return
  }
  const parsed = build === 'post' ? recognizeStoryChoiceDraft({ raw, candidates, userText: item.currentInput }) : recognizePreQuote(raw, candidates)
  if (!parsed.ok) {
    outcomes.push({ caseId: item.id, arm: build, round, kind: 'rejected', code: parsed.code })
    return
  }
  if (parsed.choiceId === null) {
    outcomes.push({ caseId: item.id, arm: build, round, kind: 'abstained' })
    return
  }
  outcomes.push({ caseId: item.id, arm: build, round, kind: 'committable', choiceId: parsed.choiceId })
}

for (let round = 1; round <= ROUNDS; round += 1) {
  for (const { item, input } of built) {
    /* ⚠️ 每轮**交替**先跑哪一臂：把"服务端漂移"平摊到两臂上 */
    const order: readonly ('pre' | 'post')[] = round % 2 === 1 ? ['pre', 'post'] : ['post', 'pre']
    for (const arm of order) await runOne(arm, item, input, round)
    process.stderr.write(`.`)
  }
}
process.stderr.write('\n')

const falsePositive = (arm: 'pre' | 'post'): number =>
  outcomes.filter((row) => row.arm === arm && row.kind === 'committable' && built.find((b) => b.item.id === row.caseId)?.item.gold === 'no_choice').length
const truePositive = (arm: 'pre' | 'post'): number =>
  outcomes.filter(
    (row) =>
      row.arm === arm &&
      row.kind === 'committable' &&
      built.find((b) => b.item.id === row.caseId)?.item.expectedChoiceId === row.choiceId,
  ).length
const noChoiceSamples = built.filter((b) => b.item.gold === 'no_choice').length * ROUNDS
const choiceSamples = built.filter((b) => b.item.gold === 'choice').length * ROUNDS
const rejectBreakdown = (arm: 'pre' | 'post'): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const row of outcomes) {
    if (row.arm !== arm || row.kind !== 'rejected') continue
    const key = row.code ?? '(无)'
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

const pre = { falsePositive: falsePositive('pre'), truePositive: truePositive('pre') }
const post = { falsePositive: falsePositive('post'), truePositive: truePositive('post') }
const measurable = noChoiceSamples > 0 && choiceSamples > 0 && pre.falsePositive > 0
const verdict = measurable && post.falsePositive < pre.falsePositive && post.truePositive >= pre.truePositive ? 'PASS' : 'NO MEASURABLE EFFECT'

console.log('')
console.log('  L-S8-31 方案 A 的 A/B 对照（真模型；两臂同一批输入）')
console.log('  ────────────────────────────────────────────────────────────')
console.log(`  臂 1（变更前）  假阳 ${String(pre.falsePositive)}/${String(noChoiceSamples)} · 真阳 ${String(pre.truePositive)}/${String(choiceSamples)}`)
console.log(`  臂 2（方案 A）  假阳 ${String(post.falsePositive)}/${String(noChoiceSamples)} · 真阳 ${String(post.truePositive)}/${String(choiceSamples)}`)
console.log(`  臂 1 拒收码：${JSON.stringify(rejectBreakdown('pre'))}`)
console.log(`  臂 2 拒收码：${JSON.stringify(rejectBreakdown('post'))}`)
console.log(`  调用次数：${String(calls)}（${String(built.length)} 案 × ${String(ROUNDS)} 轮 × 2 臂）`)
console.log(`  判定：${verdict}${measurable ? '' : '（臂 1 假阳为 0 ⇒ 天花板，判据无法成立）'}`)

let head = ''
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}
const runId = `postlv2-s8-quote-ab-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 's8-quote-ab.json'),
  JSON.stringify(
    {
      runId,
      gate: 'postlv2:s8:quote:ab:live',
      milestone: 'post-lv2 / S8 / `L-S8-31` 方案 A 的 A/B 对照（真模型）',
      generatedAt: new Date().toISOString(),
      source: { head },
      model: { wrapper: 'with-test-model', baseUrlHost: port.endpointHost ?? '(未知)', calls },
      corpus: { path: 'evals/post-lv2/s8-choice-quote/cases.json', cases: built.length, rounds: ROUNDS },
      readings: {
        pre: { ...pre, noChoiceSamples, choiceSamples, rejectBreakdown: rejectBreakdown('pre') },
        post: { ...post, noChoiceSamples, choiceSamples, rejectBreakdown: rejectBreakdown('post') },
      },
      criterion: 'PASS ⟺ 分母非零 且 假阳(post) < 假阳(pre) 且 真阳(post) ≥ 真阳(pre)',
      verdict,
      notCovered: [
        '**引用得对不对**（模型可以引用一段无关原话）—— 需要语义判定，`L-S8-31` 的边界',
        '**草稿通过 ⇒ 落账本**：本门只量草稿层；那一步由 `postlv2:s8:entry-lock:verify` 的 `L1` 单独证明',
        '生产端点与验收端点的差异（先例 `L-M85-14`）：本门的读数是**验收端点**上的',
        '单批 3 轮、小语料 ⇒ 不是长期统计（先例 `L-RTD-23`：比率不能当硬阈值）',
      ],
      outcomes,
    },
    null,
    2
  ),
  'utf8'
)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-quote-ab.json`)
process.exit(verdict === 'PASS' ? 0 : 1)
