/** v2 semantic acquisition only. Slot frequency is diagnostic, never a behavioral benefit score. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { parseReflectionDraft, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import type { ReflectionOutcomeComparison } from '../src/kernel/app/reflection/outcome-comparison.ts'
import type { ReflectionWindowEntry } from '../src/kernel/contracts/reflection-input.ts'

if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
  console.error(
    '❌ 拒绝运行：这一道门**真的出站**（真模型），必须带 `with-test-model` 包装器：\n' +
      '   pnpm with-test-model pnpm worldmodel:reflection:ab --segment=heldout\n' +
      '   （**不会**回落 `.env` 的生产 key。）'
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 语料（**冻结**；与 `docs/world-model/World-Model-Reflection-AB-Protocol-2026-10-20.md` 逐条一致）
// ---------------------------------------------------------------------------

type OutcomeCode = 'completed' | 'blocked' | 'broken' | 'cancelled'
type OutcomeKind = 'goal' | 'commitment'

interface AbCase {
  readonly id: string
  readonly segment: 'dev' | 'heldout'
  readonly outcomeKind: OutcomeKind
  readonly outcomeCode: OutcomeCode
  /** 当时预测什么（目标的原话 / 承诺的范围） */
  readonly predictedText: string
  /** 成功判据（"哪条假设"） */
  readonly criterion: string
  /** 期望：失败结局应当出现"具体修正"（一个槽位）；成功结局**不**应当 */
  readonly expectsSpecificCorrection: boolean
  /** 用户原话（窗口里的三条之一），用来给"这一轮在说什么"一点上下文 */
  readonly userLines: readonly [string, string, string]
}

const CASES: readonly AbCase[] = [
  // dev 段：只用来验台
  {
    id: 'D1', segment: 'dev', outcomeKind: 'goal', outcomeCode: 'blocked',
    predictedText: '把这次的周报写清楚并交付', criterion: '（成功判据：由用户报告确认）',
    expectsSpecificCorrection: true,
    userLines: ['对象不明确时你先问我一句。', '上次那个我也没看懂。', '以后不确定就别自己猜。'],
  },
  {
    id: 'D2', segment: 'dev', outcomeKind: 'goal', outcomeCode: 'completed',
    predictedText: '把这次的周报写清楚并交付', criterion: '（成功判据：由用户报告确认）',
    expectsSpecificCorrection: false,
    userLines: ['对象不明确时你先问我一句。', '这次写得挺清楚。', '以后不确定就别自己猜。'],
  },
  {
    id: 'D3', segment: 'dev', outcomeKind: 'commitment', outcomeCode: 'broken',
    predictedText: '答应明天之前把整理好的清单发过去', criterion: '（成功判据：本次回复里出现指定标记）',
    expectsSpecificCorrection: true,
    userLines: ['说好的清单呢？', '我不太确定你指的是哪一版。', '你答应过的事要记得。'],
  },
  {
    id: 'D4', segment: 'dev', outcomeKind: 'goal', outcomeCode: 'cancelled',
    predictedText: '把上周的会议记录补全', criterion: '（成功判据：本次回复里至少 2 项）',
    expectsSpecificCorrection: false,
    userLines: ['那个不用补了。', '对象不明确时你先问我一句。', '算了，先放着吧。'],
  },
  // 留出段：标题读数，跑**一次**
  {
    id: 'H1', segment: 'heldout', outcomeKind: 'goal', outcomeCode: 'blocked',
    predictedText: '把项目周报整理成三页发给用户', criterion: '（成功判据：由用户报告确认）',
    expectsSpecificCorrection: true,
    userLines: ['对象不明确时你先问我一句。', '这周的材料我还没给你。', '不确定就别自己猜。'],
  },
  {
    id: 'H2', segment: 'heldout', outcomeKind: 'goal', outcomeCode: 'completed',
    predictedText: '把项目周报整理成三页发给用户', criterion: '（成功判据：由用户报告确认）',
    expectsSpecificCorrection: false,
    userLines: ['对象不明确时你先问我一句。', '这次三页刚好。', '不确定就别自己猜。'],
  },
  {
    id: 'H3', segment: 'heldout', outcomeKind: 'commitment', outcomeCode: 'broken',
    predictedText: '答应今天之内把会议要点的清单交给用户', criterion: '（成功判据：本次回复里出现指定标记）',
    expectsSpecificCorrection: true,
    userLines: ['清单呢？', '我不确定你指的是哪一版。', '你答应过的事要记得。'],
  },
  {
    id: 'H4', segment: 'heldout', outcomeKind: 'goal', outcomeCode: 'blocked',
    predictedText: '把上个月的账单核对完', criterion: '（成功判据：local.file.read 执行成功）',
    expectsSpecificCorrection: true,
    userLines: ['账单你先别动。', '对象不明确时你先问我一句。', '缺文件就先说缺文件。'],
  },
  {
    id: 'H5', segment: 'heldout', outcomeKind: 'goal', outcomeCode: 'completed',
    predictedText: '把上个月的账单核对完', criterion: '（成功判据：local.file.read 执行成功）',
    expectsSpecificCorrection: false,
    userLines: ['账单核对完了吗？', '这次对得上。', '对象不明确时你先问我一句。'],
  },
  {
    id: 'H6', segment: 'heldout', outcomeKind: 'commitment', outcomeCode: 'broken',
    predictedText: '答应周末前把配置说明补上', criterion: '（成功判据：本次回复里至少 2 项）',
    expectsSpecificCorrection: true,
    userLines: ['配置说明还差一段。', '我不确定你指的是哪一版。', '你答应过的事要记得。'],
  },
  {
    id: 'H7', segment: 'heldout', outcomeKind: 'goal', outcomeCode: 'cancelled',
    predictedText: '把旧版封面重做一遍', criterion: '（成功判据：由用户报告确认）',
    expectsSpecificCorrection: false,
    userLines: ['那个封面不用做了。', '对象不明确时你先问我一句。', '先放着吧。'],
  },
  {
    id: 'H8', segment: 'heldout', outcomeKind: 'goal', outcomeCode: 'blocked',
    predictedText: '把用户要的那份清单按顺序排好', criterion: '（成功判据：本次回复里至少 2 项）',
    expectsSpecificCorrection: true,
    userLines: ['哪份清单？', '我不确定你指的是哪一版。', '对象不明确时你先问我一句。'],
  },
]

/** 结局词（诊断用：草案的 explanation 里有没有真的读到结局） */
const OUTCOME_WORDS: Readonly<Record<OutcomeCode, string>> = {
  completed: '完成',
  blocked: '受阻',
  broken: '违背',
  cancelled: '取消',
}

// ---------------------------------------------------------------------------
// 两臂的输入（**同一份窗口 / 同一份 handle**）
// ---------------------------------------------------------------------------

function windowOf(item: AbCase): ReflectionWindowEntry[] {
  const entries: ReflectionWindowEntry[] = [
    {
      id: `${item.id}:trigger`,
      kind: 'domain_event',
      revision: 10,
      sourceClass: 'internal_interpretation',
      fromTrigger: true,
      text: `（程序事件：${item.outcomeKind === 'goal' ? 'GOAL' : 'COMMITMENT'}_${item.outcomeCode.toUpperCase()}）`,
    },
  ]
  item.userLines.forEach((text, index) => {
    entries.push({
      id: `${item.id}:line-${String(index)}`,
      kind: 'conversation_event',
      revision: index + 1,
      sourceClass: 'user_statement',
      conversationId: `${item.id}-s-${String(index % 2)}`,
      fromTrigger: true,
      text,
    })
  })
  return entries
}

function comparisonOf(item: AbCase): ReflectionOutcomeComparison {
  return {
    comparisonId: `cmp:${item.id}`,
    outcomeKind: item.outcomeKind,
    outcomeRef: `${item.id}:trigger`,
    outcomeAt: 1_700_000_000_000,
    outcomeCode: item.outcomeCode,
    predictedText: item.predictedText,
    actualText:
      item.outcomeCode === 'completed' ? '（程序事实：目标已完成）'
      : item.outcomeCode === 'blocked' ? '（程序事实：目标受阻）'
      : item.outcomeCode === 'broken' ? '（程序事实：承诺已违背）'
      : '（程序事实：目标已取消）',
    ...(item.expectsSpecificCorrection ? { reviewCriterion: item.criterion } : {}),
    sourceEventIds: [`${item.id}:line-0`, `${item.id}:line-1`, `${item.id}:line-2`],
  }
}

function callOf(item: AbCase, arm: 'off' | 'on'): ReflectionDraftCall {
  const window = windowOf(item)
  return {
    characterId: 'fixture-character',
    window,
    handles: window.map((entry) => ({ kind: entry.kind, id: entry.id, sourceClass: entry.sourceClass })),
    counterHandles: [],
    ...(arm === 'on' ? { comparisons: [comparisonOf(item)] } : {}),
    triggerReasonCodes: [item.outcomeKind === 'goal' ? 'goal_outcome' : 'commitment_outcome'],
    sourceConversationCount: 2,
    deadlineMs: 20_000,
  }
}

// ---------------------------------------------------------------------------
// 跑一臂
// ---------------------------------------------------------------------------

interface ArmReading {
  readonly caseId: string
  readonly segment: 'dev' | 'heldout'
  readonly expectsSpecificCorrection: boolean
  readonly transportFailure?: boolean
  readonly rejected: boolean
  readonly rejectionReason?: string
  /** 实际调用了几次（>1 ⇒ 被限流重试过） */
  readonly attempts: number
  /** 边界违规：引用了比较材料的 id */
  readonly citedComparisonId: boolean
  readonly suggestedSlot?: string
  readonly mentionsOutcome: boolean
  readonly counterHandles: number
  readonly elapsedMs: number
}

async function runArm(item: AbCase, arm: 'off' | 'on'): Promise<ArmReading> {
  const provider = createOpenAiReflectionDraftProvider()
  const call = callOf(item, arm)
  const started = Date.now()
  let raw: unknown
  let attempts = 0
  let lastError = ''
  attempts = 1
  try { raw = await provider.call(call) }
  catch (error) {
    lastError = error instanceof Error ? error.message : ''
    return { caseId: item.id, segment: item.segment, expectsSpecificCorrection: item.expectsSpecificCorrection,
      rejected: true, transportFailure: true, rejectionReason: /HTTP \d+/.exec(lastError)?.[0] ?? 'transport_failed',
      attempts, citedComparisonId: false, mentionsOutcome: false, counterHandles: 0, elapsedMs: Date.now() - started }
  }
  const elapsedMs = Date.now() - started
  const parsed = parseReflectionDraft(typeof raw === 'string' ? raw : JSON.stringify(raw), {
    handles: call.handles,
  })
  const comparisonId = `cmp:${item.id}`
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw)
  if (!parsed.ok) {
    return {
      caseId: item.id, segment: item.segment, expectsSpecificCorrection: item.expectsSpecificCorrection,
      rejected: true, rejectionReason: parsed.reason, attempts,
      citedComparisonId: rawText.includes(comparisonId),
      mentionsOutcome: rawText.includes(OUTCOME_WORDS[item.outcomeCode]),
      counterHandles: 0, elapsedMs,
    }
  }
  return {
    caseId: item.id,
    segment: item.segment,
    expectsSpecificCorrection: item.expectsSpecificCorrection,
    rejected: false,
    attempts,
    ...(parsed.draft.suggestedSlot === undefined ? {} : { suggestedSlot: parsed.draft.suggestedSlot }),
    citedComparisonId: [...parsed.draft.supportHandles, ...parsed.draft.counterHandles].includes(comparisonId),
    mentionsOutcome: parsed.draft.explanation.includes(OUTCOME_WORDS[item.outcomeCode]),
    counterHandles: parsed.draft.counterHandles.length,
    elapsedMs,
  }
}

function aggregate(readings: readonly ArmReading[]): {
  readonly n: number
  readonly rejected: number
  readonly boundaryViolations: number
  readonly specificCorrections: number
  readonly specificExpected: number
  readonly overReads: number
  readonly successCases: number
  readonly outcomeMentions: number
  readonly counterHandles: number
  readonly attempts: number
  readonly elapsedMs: number
} {
  const failedCases = readings.filter((row) => row.expectsSpecificCorrection)
  const successCases = readings.filter((row) => !row.expectsSpecificCorrection)
  return {
    n: readings.length,
    rejected: readings.filter((row) => row.rejected).length,
    boundaryViolations: readings.filter((row) => row.citedComparisonId).length,
    specificCorrections: failedCases.filter((row) => row.suggestedSlot !== undefined).length,
    specificExpected: failedCases.length,
    overReads: successCases.filter((row) => row.suggestedSlot !== undefined).length,
    successCases: successCases.length,
    outcomeMentions: readings.filter((row) => row.mentionsOutcome).length,
    counterHandles: readings.reduce((sum, row) => sum + row.counterHandles, 0),
    attempts: readings.reduce((sum, row) => sum + row.attempts, 0),
    elapsedMs: readings.reduce((sum, row) => sum + row.elapsedMs, 0),
  }
}

// ---------------------------------------------------------------------------
// 跑批
// ---------------------------------------------------------------------------

const only = process.argv.find((arg) => arg.startsWith('--segment='))?.slice('--segment='.length)
const segment = only === 'dev' || only === 'heldout' ? only : 'all'
const cases = CASES.filter((item) => segment === 'all' || item.segment === segment)

const off: ArmReading[] = []
const on: ArmReading[] = []
for (const item of cases) {
  off.push(await runArm(item, 'off'))
  // 两臂之间留一点间隔（测试端点的限流是按分钟的）
  await new Promise((done) => setTimeout(done, 800))
  on.push(await runArm(item, 'on'))
  await new Promise((done) => setTimeout(done, 800))
}

const report = {
  schema: 'world-model-reflection-ab@2',
  status: [...off, ...on].some(row => row.transportFailure) ? 'FAIL' : 'PASS',
  acquisitionComplete: [...off, ...on].every(row => !row.transportFailure),
  protocol: 'docs/world-model/World-Model-Continuation-Protocol-v2.md',
  segment,
  model: {
    host: (() => {
      try {
        return new URL((process.env.OPENAI_BASE_URL ?? '').trim()).host
      } catch {
        return '(未设)'
      }
    })(),
    model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(未设)',
    keyPresent: (process.env.OPENAI_API_KEY ?? '').trim().length > 0,
  },
  segments: Object.fromEntries(
    (['dev', 'heldout'] as const)
      .filter((name) => cases.some((item) => item.segment === name))
      .map((name) => {
        const offRows = off.filter((row) => row.segment === name)
        const onRows = on.filter((row) => row.segment === name)
        return [name, {
          off: aggregate(offRows),
          on: aggregate(onRows),
          rows: offRows.map((row, index) => ({ caseId: row.caseId, expects: row.expectsSpecificCorrection,
            off: { ...offRows[index]! }, on: { ...onRows[index]! } })),
        }]
      })
  ),
  evidenceClass: 'real_model_semantic_ab_frozen_corpus',
  databaseOpened: false,
  realToolCalls: 0,
  productionIntegrated: false,
  benefitMeasured: 'reflection_domain_semantic_layer_only__no_behavioral_or_experience_claim',
  notes: [
    '语义层读数（草案形状），不是"她的行为变好了"。',
    '"具体修正率"是**代理**指标（给出槽位 ≠ 修正有效）。',
    '体验收益要独立真人盲审；本轮**没有**做。',
  ],
}

const out = resolve(
  'artifacts/post-lv2/local/world-model-reflection-ab-v2',
  new Date().toISOString().replace(/[:.]/g, '-')
)
mkdirSync(out, { recursive: true })
// ⚠️ 证据要绑到源码（聚合门读它判 `INVALID`）——与工具域 A/B 同一条纪律。
const hashedFiles = [
  'scripts/world-model-reflection-ab.ts',
  'src/infrastructure/model/openai-reflection.ts',
  'src/kernel/app/reflection/outcome-comparison.ts',
  'src/kernel/contracts/reflection.ts',
  'docs/world-model/World-Model-Continuation-Protocol-v2.md',
]
writeFileSync(resolve(out, 'ab.json'), JSON.stringify({
  ...report,
  sourceHashes: Object.fromEntries(
    hashedFiles.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])
  ),
}, null, 2) + '\n')

for (const name of ['dev', 'heldout'] as const) {
  const rows = report.segments[name]
  if (rows === undefined) continue
  console.log(
    `[${name}] A(off) 拒收=${String(rows.off.rejected)} 边界违规=${String(rows.off.boundaryViolations)} ` +
      `失败结局槽位建议=${String(rows.off.specificCorrections)}/${String(rows.off.specificExpected)} ` +
      `其它结局槽位建议=${String(rows.off.overReads)}/${String(rows.off.successCases)} 结局提及=${String(rows.off.outcomeMentions)}/${String(rows.off.n)}`
  )
  console.log(
    `[${name}] B(on)  拒收=${String(rows.on.rejected)} 边界违规=${String(rows.on.boundaryViolations)} ` +
      `失败结局槽位建议=${String(rows.on.specificCorrections)}/${String(rows.on.specificExpected)} ` +
      `其它结局槽位建议=${String(rows.on.overReads)}/${String(rows.on.successCases)} 结局提及=${String(rows.on.outcomeMentions)}/${String(rows.on.n)}`
  )
}
console.log(JSON.stringify({ status: report.status, segment, output: out }))
if (!report.acquisitionComplete) process.exitCode = 1
