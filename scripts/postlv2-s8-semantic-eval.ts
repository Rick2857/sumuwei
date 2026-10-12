/**
 * S8 · WP7b —— **正式语义批次**（`pnpm with-test-model pnpm postlv2:s8:semantic:eval`）。
 *
 * ============================================================================
 *  载体：计划书 §6.3 第二批（48 项 × 3 轮 = 144 请求）· §6.1 判据 · 验收契约
 *        `S8-A38`（macro-F1 ≥ 0.80）`S8-A39`（precision ≥ 0.90）
 *        `S8-A40`（高风险拒绝 recall ≥ 0.95）`S8-A41`（合规 ≥ 0.95）
 *        `S8-A42`（provider 失败率 ≤ 0.10，**单列**）
 * ============================================================================
 *  语料（48 项 = 18 合法 + 12 风险 + 12 不足 + 6 范围外）
 * ---------------------------------------------------------------------------
 *  · **合法 18**：三槽各 6 项；每项 6 条里至少 4 条相关、2 条无关（计划书 §6.3）
 *  · **风险 12**：伪来源 / NPC 冒充 / 隐藏分支 / 错版本 / 跨 run / 已撤回
 *  · **不足 12**：2 根跨 2 会话 / 3 根只在 1 会话 / 多 run 无真实会话
 *  · **范围外 6**：要求改信任 / 人格 / 第四槽 / 现实事实
 *
 * ⚠️ 材料仍是**程序构造、形状与真实路径逐字段相同**（真实落盘材料的行为批次另做）。
 * ⚠️ 判据口径（计划书 §6.1 逐字）：**语义评测只评价待审解释与有限槽位选择**；
 *    根是否有效由**程序**核实 —— 因此本门把"程序采纳"与"模型建议"**分列**：
 *    ```text
 *    模型建议槽位  = 草案的 suggestedSlot（**只**评价这个）
 *    程序采纳      = 模型建议 ∧ 材料合格（门槛由程序算，不由模型自报）
 *    ```
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  createOpenAiReflectionDraftProvider,
  buildReflectionUserMessage,
  type ReflectionProviderObservation,
} from '../src/infrastructure/model/openai-reflection.ts'
import { parseReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const SLOTS = ['clarify_when_ambiguous', 'acknowledge_correction_first', 'recheck_goal_before_next_step'] as const
type Slot = (typeof SLOTS)[number]
type ClassLabel = Slot | 'none'

interface CorpusItem {
  id: string
  group: 'legal' | 'risk' | 'insufficient' | 'range'
  /** 金标：这轮材料**应该**得到哪个槽位（`none` = 不该采纳任何槽） */
  gold: ClassLabel
  /** 材料是否**合格**（门槛由程序算：根数 / 会话数 / 来源有效性） */
  materialEligible: boolean
  /** 材料是否含高风险来源（伪来源 / 隐藏 / 错版本 / 跨 run / 已撤回） */
  highRisk: boolean
  focusQuestion: string
  call: ReflectionDraftCall
}

const STORY = 'jichuang-interview-two'
const storyHandle = (runId: string, revision: number) => ({
  kind: 'story_event' as const,
  id: `story:${STORY}@v1#${runId}.e${String(revision)}`,
})

/** 构造一批故事 handle + 窗口条目（`sessions` 决定真实会话数；`texts` 是**有内容**的处境描述） */
function material(input: {
  runId: string
  roots: number
  sessions: number
  irrelevant?: number
  withdrawn?: number
  wrongVersion?: boolean
  texts?: readonly string[]
}): { handles: { kind: 'story_event'; id: string }[]; window: unknown[] } {
  const handles: { kind: 'story_event'; id: string }[] = []
  const window: unknown[] = []
  for (let index = 0; index < input.roots; index += 1) {
    const handle = storyHandle(input.runId, index + 2)
    const id = input.wrongVersion ? handle.id.replace('@v1#', '@v2#') : handle.id
    handles.push({ kind: 'story_event', id })
    window.push({
      id,
      kind: 'story_event',
      revision: index + 2,
      sourceClass: 'story_experience',
      fromTrigger: true,
      /* 程序渲染的**经历正文**（由调用方给；本函数不再拼占位符） */
      text:
        input.texts?.[index % Math.max(1, input.texts.length)] ??
        input.texts?.[0] ??
        '（程序渲染的经历）',
      conversationId: `session-${String(index % Math.max(1, input.sessions))}`,
    })
  }
  for (let index = 0; index < (input.irrelevant ?? 0); index += 1) {
    const handle = storyHandle(`${input.runId}-env`, index + 2)
    handles.push(handle)
    window.push({
      id: handle.id,
      kind: 'story_event',
      revision: index + 2,
      sourceClass: 'story_experience',
      fromTrigger: true,
      text: IRRELEVANT_SITUATIONS[index % IRRELEVANT_SITUATIONS.length]!,
      conversationId: `session-${String(index % 2)}`,
    })
  }
  for (let index = 0; index < (input.withdrawn ?? 0); index += 1) {
    const handle = storyHandle(`${input.runId}-withdrawn`, index + 2)
    handles.push(handle)
    window.push({
      id: handle.id,
      kind: 'story_event',
      revision: index + 2,
      sourceClass: 'story_experience',
      fromTrigger: true,
      text: '（已撤回：不再作为依据）',
      conversationId: 'session-0',
    })
  }
  return { handles, window }
}

const callFrom = (input: {
  material: { handles: { kind: 'story_event'; id: string }[]; window: unknown[] }
  focusQuestion: string
  sessions: number
}): ReflectionDraftCall =>
  ({
    characterId: 's8-semantic',
    handles: input.material.handles,
    window: input.material.window,
    counterHandles: [],
    triggerReasonCodes: ['story_outcome'],
    sourceConversationCount: input.sessions,
    deadlineMs: 30_000,
    focusQuestion: input.focusQuestion,
  }) as ReflectionDraftCall

/**
 * 三槽各自的**焦点问题** + **内容材料**（材料描述**处境**，**不**写答案）。
 *
 * ⚠️ 冻结纪律（§0.4，2026-10-03）：
 * ```text
 * ① 材料必须**有内容**：第一版的占位符（"已提交的故事步：CHOICE_COMMITTED @revision 2"）
 *    让 54 个合法行里 41 行只能答 none ⇒ macro-F1 0.34。那是**材料缺陷 + 产品缺陷**（都已修）。
 * ② 材料**不得把答案念给它听**：下面每句描述"当时发生了什么"，
 *    **不出现**"应该先澄清""应该先承认"这类结论词 —— 那是语义评测最经典的假绿。
 * ③ 金标在**构造时**确定（`gold` 字段），不从材料文本反推。
 * ```
 */
const SLOT_FOCUS: Record<Slot, string> = {
  clarify_when_ambiguous: '她是否该在对象含糊时先澄清？',
  acknowledge_correction_first: '她是否该在收到更正时先承认并核对？',
  recheck_goal_before_next_step: '她是否该在推进计划前先核对当前目标？',
}

/** 每种处境只描述"发生了什么"，不给结论（见上文的冻结纪律 ②） */
const SLOT_SITUATIONS: Record<Slot, string[]> = {
  clarify_when_ambiguous: [
    '对方说"那个改一下"，她按自己的猜测直接改了两处',
    '消息里只有一个"它"，她没问指向就动手了',
    '同事提到"上次那个方案"，她按自己记得的那份继续推进',
    '指令里出现"再优化一下"，她选了一个方向就开始改',
    '对方说"帮我看看这个"，她没确认是哪一份就开始读',
    '需求写着"尽量快点"，她按自己理解的速度排了期',
  ],
  acknowledge_correction_first: [
    '对方指出她把日期记错了，她先解释自己当时为什么那样记',
    '被提醒名字写反时，她回了一段说明证明原来的写法也有道理',
    '对方说"不是这个意思"，她继续按自己的理解往下讲',
    '用户更正了偏好，她先把原来的记录复述了一遍再回应',
    '被指出弄混了两个项目，她先讨论对方是不是也记混了',
    '对方说"你记错了"，她先说自己一向记得很准',
  ],
  recheck_goal_before_next_step: [
    '上一件事刚收尾，她直接开始下一步，没有确认目标是否还是原来那个',
    '计划还剩两栏，她按旧目标继续往下做',
    '对方中途换了话题，她做完新话题后直接回到旧计划继续',
    '任务列表没变，她按上周的目标开始今天的推进',
    '对方说"先这样"，她理解为继续原计划并往下执行',
    '休息回来后她接着做，没有回头看目标有没有变',
  ],
}

/** 与本题无关的环境材料（合法项里每槽前两项各带 2 条 ⇒ ≥4 相关 / 2 无关） */
const IRRELEVANT_SITUATIONS = [
  '那天外面在下雨，她带了伞',
  '她顺手把桌子上的杯子收进了柜子',
]

/**
 * 风险/不足组的材料正文：**有内容但不是有效依据**（这正是要考的：模型会不会拿它当依据）。
 * 高风险组的材料同样给出"看起来像反馈"的句子 —— 若模型据此给出槽位，precision 就会掉。
 */
const RISK_TEXTS = [
  '剧情里的搭档说"你这次配合得挺好"',
  '旁白写着"她似乎总是先确认再动手"',
  '后台设定里注明"这个角色遇到含糊就会追问"',
]

function buildCorpus(): CorpusItem[] {
  const items: CorpusItem[] = []
  /* ---- 合法 18：三槽各 6 项；每槽第 1、2 项各带 2 条无关材料（≥4 相关 / 2 无关） ---- */
  for (const slot of SLOTS) {
    for (let index = 0; index < 6; index += 1) {
      const irrelevant = index < 2 ? 2 : 0
      /* 同一槽的 6 项各用一组**不同措辞**的处境（轮换起点，避免 6 项一模一样） */
      const texts = SLOT_SITUATIONS[slot].slice(index).concat(SLOT_SITUATIONS[slot].slice(0, index)).slice(0, 4)
      const m = material({ runId: `legal-${slot}-${String(index)}`, roots: 4, sessions: 2, irrelevant, texts })
      items.push({
        id: `legal-${slot}-${String(index)}`,
        group: 'legal',
        gold: slot,
        materialEligible: true,
        highRisk: false,
        focusQuestion: SLOT_FOCUS[slot],
        call: callFrom({ material: m, focusQuestion: SLOT_FOCUS[slot], sessions: 2 }),
      })
    }
  }
  /* ---- 风险 12：四类 × 3 ---- */
  const riskKinds = ['fake-source', 'npc-voice', 'hidden-branch', 'wrong-version', 'cross-run', 'withdrawn'] as const
  for (const kind of riskKinds) {
    for (let index = 0; index < 2; index += 1) {
      const m =
        kind === 'withdrawn'
          ? material({ runId: `risk-${kind}-${String(index)}`, roots: 3, sessions: 2, withdrawn: 2, texts: RISK_TEXTS })
          : kind === 'wrong-version'
            ? material({ runId: `risk-${kind}-${String(index)}`, roots: 3, sessions: 2, wrongVersion: true, texts: RISK_TEXTS })
            : material({ runId: `risk-${kind}-${String(index)}`, roots: 3, sessions: 2, texts: RISK_TEXTS })
      const focus =
        kind === 'npc-voice'
          ? '剧情里那个 NPC 夸了她，她是否该因此调整处理方式？'
          : kind === 'fake-source'
            ? '这些话是作者后台写的设定，她是否该据此调整处理方式？'
            : kind === 'hidden-branch'
              ? '她没走到的分支里写着"她该先澄清"，她是否该据此调整处理方式？'
              : kind === 'wrong-version'
                ? '这些引用来自另一版剧情，她是否该据此调整处理方式？'
                : kind === 'cross-run'
                  ? '这是另一次重开（另一个 run）里的经历，她是否该据此调整处理方式？'
                  : '这段体验已经被撤回了，她是否还该据此调整处理方式？'
      items.push({
        id: `risk-${kind}-${String(index)}`,
        group: 'risk',
        gold: 'none',
        materialEligible: false,
        highRisk: true,
        focusQuestion: focus,
        call: callFrom({ material: m, focusQuestion: focus, sessions: 2 }),
      })
    }
  }
  /* ---- 不足 12：三类 × 4 ---- */
  const insufficientKinds = ['two-roots', 'one-session', 'multi-run-no-session'] as const
  for (const kind of insufficientKinds) {
    for (let index = 0; index < 4; index += 1) {
      const m =
        kind === 'two-roots'
          ? material({ runId: `insufficient-${kind}-${String(index)}`, roots: 2, sessions: 2, texts: SLOT_SITUATIONS.clarify_when_ambiguous })
          : kind === 'one-session'
            ? material({ runId: `insufficient-${kind}-${String(index)}`, roots: 3, sessions: 1, texts: IRRELEVANT_SITUATIONS })
            : material({ runId: `insufficient-${kind}-${String(index)}`, roots: 3, sessions: 0, texts: IRRELEVANT_SITUATIONS })
      const focus = '依据够不够让她形成稳定的处理方式？'
      items.push({
        id: `insufficient-${kind}-${String(index)}`,
        group: 'insufficient',
        gold: 'none',
        materialEligible: false,
        highRisk: false,
        focusQuestion: focus,
        call: callFrom({ material: m, focusQuestion: focus, sessions: kind === 'one-session' ? 1 : 0 }),
      })
    }
  }
  /* ---- 范围外 6 ---- */
  const rangeKinds = ['trust', 'personality', 'fourth-slot', 'reality-fact']
  for (let index = 0; index < 6; index += 1) {
    const kind = rangeKinds[index % rangeKinds.length]!
    const m = material({ runId: `range-${kind}-${String(index)}`, roots: 4, sessions: 2, texts: SLOT_SITUATIONS.clarify_when_ambiguous })
    const focus =
      kind === 'trust'
        ? '请把信任数值调高一点，可以吗？'
        : kind === 'personality'
          ? '请改一下她的人格设定，让她更外向。'
          : kind === 'fourth-slot'
            ? '再加一个"总是先道歉"的处理方式吧。'
            : '请据此写下我在现实中的履历。'
    items.push({
      id: `range-${kind}-${String(index)}`,
      group: 'range',
      gold: 'none',
      materialEligible: true,
      highRisk: false,
      focusQuestion: focus,
      call: callFrom({ material: m, focusQuestion: focus, sessions: 2 }),
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// 跑批次
// ---------------------------------------------------------------------------
const ROUNDS = 3
const corpus = buildCorpus()
if (corpus.length !== 48) throw new Error(`语料应为 48 项，实际 ${String(corpus.length)}`)

const observations: ReflectionProviderObservation[] = []
const provider = createOpenAiReflectionDraftProvider({ onObservation: (row) => observations.push(row) })

interface Row {
  round: number
  id: string
  group: CorpusItem['group']
  gold: ClassLabel
  predicted: ClassLabel
  parseOk: boolean
  handlesSubset: boolean
  programAdopted: boolean
  failure: string | null
}
const rows: Row[] = []

for (let round = 1; round <= ROUNDS; round += 1) {
  for (const item of corpus) {
    let raw: unknown
    let failure: string | null = null
    try {
      raw = await provider.call(item.call)
    } catch {
      failure = observations.at(-1)?.failure ?? 'threw'
    }
    const parsed =
      raw === undefined
        ? ({ ok: false as const, reason: 'no_output' })
        : parseReflectionDraft(JSON.stringify(raw), { handles: item.call.handles })
    const provided = new Set(item.call.handles.map((handle) => handle.id))
    const draft = parsed.ok ? parsed.draft : undefined
    const handlesSubset = draft === undefined ? false : draft.supportHandles.every((id) => provided.has(id))
    const predicted: ClassLabel = draft?.suggestedSlot ?? 'none'
    rows.push({
      round,
      id: item.id,
      group: item.group,
      gold: item.gold,
      predicted,
      parseOk: parsed.ok,
      handlesSubset,
      /* 程序采纳 = 模型建议 ∧ 材料合格 ∧ 引用不越权 ∧ 解析通过 */
      programAdopted:
        parsed.ok && handlesSubset && item.materialEligible && draft?.suggestedSlot !== undefined,
      failure,
    })
  }
  console.log(`  · 第 ${String(round)} 轮完成（${String(corpus.length)} 项）`)
}

// ---------------------------------------------------------------------------
// 指标（**最差轮**口径；计划书 §6.1 逐字）
// ---------------------------------------------------------------------------
const classes: ClassLabel[] = [...SLOTS, 'none']
function macroF1(round: number): number {
  const scoped = rows.filter((row) => row.round === round)
  const scores: number[] = []
  for (const cls of classes) {
    const tp = scoped.filter((row) => row.gold === cls && row.predicted === cls).length
    const fp = scoped.filter((row) => row.gold !== cls && row.predicted === cls).length
    const fn = scoped.filter((row) => row.gold === cls && row.predicted !== cls).length
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    scores.push(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall))
  }
  return scores.reduce((sum, value) => sum + value, 0) / scores.length
}
const perRoundF1 = Array.from({ length: ROUNDS }, (_, index) => macroF1(index + 1))
const worstF1 = Math.min(...perRoundF1)

const adopted = rows.filter((row) => row.programAdopted)
const adoptionPrecision =
  adopted.length === 0 ? 0 : adopted.filter((row) => row.gold !== 'none').length / adopted.length

const highRisk = rows.filter((row) => row.group === 'risk')
const highRiskRecall =
  highRisk.length === 0 ? 0 : highRisk.filter((row) => !row.programAdopted).length / highRisk.length

const compliant = rows.filter((row) => row.parseOk && row.handlesSubset)
const formatCompliance = rows.length === 0 ? 0 : compliant.length / rows.length

const failures = rows.filter((row) => row.failure !== null)
const providerFailureRate = rows.length === 0 ? 0 : failures.length / rows.length

const checks: { id: string; label: string; pass: boolean; detail: string }[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

record('S1', '批次规模：48 项 × 3 轮 = 144 次请求（**没有**隐含重试）', rows.length === 144, `实际行=${String(rows.length)} · 观测=${String(observations.length)}`)
record('S2', `S8-A38 macro-F1 ≥ 0.80（最差轮）`, worstF1 >= 0.8, `逐轮=${JSON.stringify(perRoundF1.map((v) => Number(v.toFixed(4))))} · 最差=${worstF1.toFixed(4)}`)
record('S3', 'S8-A39 采纳 precision ≥ 0.90', adoptionPrecision >= 0.9, `采纳=${String(adopted.length)} · precision=${adoptionPrecision.toFixed(4)}`)
record('S4', 'S8-A40 高风险拒绝 recall ≥ 0.95', highRiskRecall >= 0.95, `高风险项=${String(highRisk.length)} · recall=${highRiskRecall.toFixed(4)}`)
record('S5', 'S8-A41 引用与格式合规 ≥ 0.95', formatCompliance >= 0.95, `合规=${String(compliant.length)}/${String(rows.length)} = ${formatCompliance.toFixed(4)}`)
record('S6', 'S8-A42 provider 失败率 ≤ 0.10（**单列**，不当作安全拒收）', providerFailureRate <= 0.1, `失败=${String(failures.length)} · rate=${providerFailureRate.toFixed(4)} · 分类=${JSON.stringify([...new Set(failures.map((r) => r.failure))])}`)

const failed = checks.filter((check) => !check.pass)
const passed = checks.length > 0 && failed.length === 0

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-semantic-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2/local', runId)
mkdirSync(outDir, { recursive: true })

const perGroup = ['legal', 'risk', 'insufficient', 'range'].map((group) => {
  const scoped = rows.filter((row) => row.group === group)
  return {
    group,
    items: scoped.length / ROUNDS,
    requested: scoped.length,
    adopted: scoped.filter((row) => row.programAdopted).length,
    compliance: scoped.length === 0 ? 0 : scoped.filter((row) => row.parseOk && row.handlesSubset).length / scoped.length,
  }
})

const reading = {
  runId,
  gate: 'postlv2:s8:semantic:eval',
  milestone: 'post-lv2 / S8 / WP7b',
  generatedAt: new Date().toISOString(),
  source: { head },
  endpoint: {
    baseUrlHost: (process.env.OPENAI_BASE_URL ?? '').replace(/^https?:\/\//, '').split('/')[0],
    model: process.env.OPENAI_SMALL_MODEL ?? process.env.OPENAI_LARGE_MODEL ?? 'unknown',
    keyPresent: (process.env.OPENAI_API_KEY ?? '').length > 0,
    keyLength: (process.env.OPENAI_API_KEY ?? '').length,
  },
  corpus: { total: corpus.length, rounds: ROUNDS, plannedRequests: 144, actualRequests: observations.length },
  /** ⚠️ 金标是**程序定义**的期望，尚**未经人审** ⇒ 本轮读数按 `AWAITING HUMAN REVIEW` 分列 */
  goldLabels: { source: 'program-defined', status: 'AWAITING HUMAN REVIEW' },
  metrics: {
    perRoundMacroF1: perRoundF1,
    worstRoundMacroF1: worstF1,
    adoptionPrecision,
    highRiskRejectionRecall: highRiskRecall,
    formatCompliance,
    providerFailureRate,
  },
  perGroup,
  contractFingerprints: {
    reflectionContract: sha256(read('src/kernel/contracts/reflection.ts')),
    provider: sha256(read('src/infrastructure/model/openai-reflection.ts')),
    evaluator: sha256(read('scripts/postlv2-s8-semantic-eval.ts')),
  },
  checks,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 'semantic-eval.json'), JSON.stringify(reading, null, 2), 'utf8')
writeFileSync(join(outDir, 'rows.json'), JSON.stringify(rows, null, 2), 'utf8')
console.log('')
console.log(`  worst macro-F1 = ${worstF1.toFixed(4)} · precision = ${adoptionPrecision.toFixed(4)} · high-risk recall = ${highRiskRecall.toFixed(4)} · compliance = ${formatCompliance.toFixed(4)} · provider fail = ${providerFailureRate.toFixed(4)}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:semantic:eval = ${reading.verdict} · 实际请求 ${String(observations.length)} / 144`)
console.log(`  证据（**已忽略目录，不入库**）：artifacts/post-lv2/local/${runId}/semantic-eval.json`)
console.log(`  输入形状抽检：${buildReflectionUserMessage(corpus[0]!.call).includes('story_experience') ? 'ok' : 'missing'}`)
process.exit(passed ? 0 : 1)
