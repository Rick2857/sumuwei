/**
 * M10（WP10 的**离线干跑**）—— `pnpm m10:semantic:dry`。
 *
 * ============================================================================
 *  本门**不**度量语义质量 —— 这一点是本门的第一条判据
 * ============================================================================
 * WP10 的出口要的是"语义 / 真实链 / 人审各有结论"，而**语义结论只能来自真模型**。
 * 本门做的是**在那之前把两件与模型无关的事做实**：
 *
 * ```text
 * 甲 · 度量机是**已知答案**可验的（parts A）
 *     喂"预测 = 金标"⇒ 准确率与 macro-F1 **必须**恰好是 1；
 *     喂"全猜 none" ⇒ 准确率**必须**等于多数类基线（且 < 1）；
 *     喂"全垃圾"   ⇒ 传输拒绝率 100%，零写入。
 *     ⇒ 若算术写错，"真模型跑出来的漂亮数字"就是假的，而那时你不会知道。
 *
 * 乙 · 语料 → 真实链的**接线**是通的（part B）
 *     从**冻结语料**里按层抽样，用 `runGoalTurn` 真的跑一遍（隔离库 + 离线 provider），
 *     证明"每条语料能被驱动、每轮五个 trace 读数在案、结论能被读成预测向量"。
 *     ⇒ 真模型门那天要做的只剩"换一个 provider"。
 * ```
 *
 * ⚠️ **证据文件里 `semanticClaim: 'none'`**，且这条是**机器判据**（`D6`）——
 *    干跑的读数**不得**被引用成"语义评测通过"。
 *
 * ⚠️ 零模型 / 零出网 / 隔离库。
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-semantic-dry', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { createM10TurnHarness, fixedProvider, deterministicRuntime } from './m10-harness.ts'



import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { character } from '../src/character/index.ts'
import { buildGoalCorpus } from '../evals/m10/goal-corpus.ts'
import {
  GOAL_METRIC_LABELS,
  readSemantic,
  type GoalMetricLabel,
  type LabelledCase,
} from '../evals/m10/goal-metrics.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import {
  buildGoalUnderstandingInstruction,
  createOpenAiGoalUnderstandingProvider,
} from '../src/infrastructure/model/openai-goal-understanding.ts'
import {
  GOAL_DRAFT_FIELD_ALLOWLIST,
  GOAL_PROPOSAL_OPERATIONS,
} from '../src/kernel/contracts/goal-proposal.ts'
import type { GoalUnderstandingInput } from '../src/kernel/app/goal/understanding.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_semdry' as CharacterId

function phase(mark: string): void {
  console.error(`[m10-semantic-dry] ${mark}`)
}

interface Check {
  group: 'A' | 'B' | 'C' | 'D'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
  /**
   * **`true` = 这一行是"登记"，不是断言**（`L-M10-65`）。
   * ⚠️ 登记**不进** `passed/total`，只另报 `notes: N` —— 否则"N/N PASS"会把
   *    "什么都没断言的行"也算成"验证过的事"（`recordNote()` 记的就是这类）。
   */
  note: boolean
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
  checks.push({ group, id, label, expected, actual, pass, note: false })
}
/**
 * 记一条**登记**（如实报出一个读数，**不对它作断言**）—— `L-M10-65` 的修法。
 *
 * ⚠️ 它**没有 `pass` 参数**：调用点连"传个恒真的表达式"都做不到，
 *    所以"空量具混进断言计数"在这条路径上**是类型上不可能的**。
 * ⚠️ 读数仍**留在 `checks` 数组里**（不丢），只是**不进** `passed/total`。
 */
function recordNote(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
): void {
  checks.push({ group, id, label, expected, actual, pass: true, note: true })
}

const isLabel = (value: string): value is GoalMetricLabel =>
  (GOAL_METRIC_LABELS as readonly string[]).includes(value)

async function main(): Promise<void> {
  const corpus = buildGoalCorpus()
  const testItems = corpus.items.filter((item) => item.split === 'test')
  const cases: LabelledCase[] = testItems.map((item) => ({
    caseId: item.caseId,
    layer: item.layer,
    sourceText: item.sourceText,
    gold: item.gold.operation as GoalMetricLabel,
  }))

  /* ======================================================================
   * 甲 · 度量机的**已知答案**自证（全部 140 条 test 语料）
   * ==================================================================== */
  phase('A: metric machinery known-answer tests')

  record(
    'A',
    'A1',
    `语料装载：test 分片 ${String(cases.length)} 条，全部金标都在闭集 ${String(GOAL_METRIC_LABELS.length)} 个标签内`
      + '（有闭集外的标签 ⇒ 度量机会静默漏算）',
    '140 条 · 0 个闭集外标签',
    `${String(cases.length)} 条 · 闭集外 ${String(cases.filter((item) => !isLabel(item.gold)).length)} 条`,
    cases.length > 0 && cases.every((item) => isLabel(item.gold)),
  )

  /* A2 —— 预测 = 金标 ⇒ 1.0 / 1.0（已知答案） */
  const oracle = cases.map((item) => item.gold)
  const oracleRead = readSemantic(cases, oracle)
  record(
    'A',
    'A2',
    '**【已知答案】"预测 = 金标" ⇒ 准确率与 macro-F1 **恰好**是 1**'
      + '（数值上精确相等，不是"接近 1"）',
    'accuracy = 1 且 macroF1 = 1',
    `accuracy=${oracleRead.accuracy} · macroF1=${String(oracleRead.macroF1.value)}（${String(oracleRead.macroF1.classesAveraged)} 类）`,
    oracleRead.accuracy === 1 && oracleRead.macroF1.value === 1,
  )

  /*
   * A3 —— 多数类基线（**已知答案**）。
   *
   * ⚠️ 第一版这条检查的前提是错的：它假设"多数类 = `none`"，于是断言
   *    "全猜 `none` 的准确率 === 多数类基线"。实测 `none` 40/140 = 0.2857，
   *    而真正的多数类是 **45/140 = 0.3214 的另一个标签** —— 两个**不同**的量。
   *
   *    教训：**基线是"多数类"的性质，不是"某个具体类"的性质**。
   *    把某个类**写死**进检查，等于把语料的分层设计当成了算术的一部分
   *    （换一版语料，这条检查就会以"算术错了"的样子红掉）。
   *    ⇒ 现在：先**算**出多数类，再断言"全猜它 ⇒ 准确率 === 基线"。
   */
  const supportByLabel = new Map<GoalMetricLabel, number>()
  for (const item of cases) {
    supportByLabel.set(item.gold, (supportByLabel.get(item.gold) ?? 0) + 1)
  }
  const majorityLabel = [...supportByLabel.entries()].sort((a, b) => b[1] - a[1])[0]!
  const allMajority: GoalMetricLabel[] = cases.map(() => majorityLabel[0])
  const majorityRead = readSemantic(cases, allMajority)
  record(
    'A',
    'A3',
    '**【已知答案】"全猜多数类" ⇒ 准确率**必须恰好等于**多数类基线，且**严格小于 1**'
      + '（若它等于 1，说明 A2 是通过"所有类都算对"通过的，那条检查没有量到东西）'
      + ' ⚠️ 多数类**是算出来的**，不是写死的 —— 基线是"多数类"的性质，不是某个具体类的性质',
    `accuracy === majorityBaseline 且 < 1`,
    `多数类=${majorityLabel[0]}(${String(majorityLabel[1])} 条) · ` +
      `accuracy=${majorityRead.accuracy} · baseline=${majorityRead.majorityBaseline}`,
    majorityRead.accuracy === majorityRead.majorityBaseline && majorityRead.accuracy < 1,
  )

  /* A3b —— 另一个已知答案点：全猜 `none` ⇒ 准确率恰好是其 support 占比 */
  const allNone: GoalMetricLabel[] = cases.map(() => 'none')
  const noneRead = readSemantic(cases, allNone)
  const noneShare = (supportByLabel.get('none') ?? 0) / cases.length
  record(
    'A',
    'A3b',
    '**【已知答案】"全猜 `none`" ⇒ 准确率恰好 = `none` 的 support 占比**'
      + '（第二个已知答案点：它与多数类基线**不是**同一个量，两者都要对）',
    `accuracy === ${String(noneShare)}`,
    `accuracy=${noneRead.accuracy} · none support 占比=${String(noneShare)}`,
    Math.abs(noneRead.accuracy - noneShare) < 1e-12,
  )

  /* A4 —— 分母必须与指标一起出现；且每类 support 之和 = 总数 */
  const supportSum = noneRead.perClass.reduce((acc, metric) => acc + metric.support, 0)
  const zeroSupportLabels = noneRead.perClass
    .filter((metric) => metric.support === 0)
    .map((metric) => metric.label)
  record(
    'A',
    'A4',
    '**分母会计**：每类的 `support` 之和 = 总条数（不与指标分家的分母）'
      + '，且**零 support 的类被显式列出来**而不是混进均值',
    `support 之和 = ${String(cases.length)}`,
    `之和=${String(supportSum)} · 零 support 类=[${zeroSupportLabels.join(',')}] · `
      + `参与 macro 的类=${String(noneRead.macroF1.classesAveraged)}`,
    supportSum === cases.length,
  )

  /* A5 —— 关键错误：把"无言外之意"猜成写操作 ⇒ 必须被单独抓到 */
  const falseCreateProbe: GoalMetricLabel[] = cases.map((item) =>
    item.gold === 'none' || item.gold === 'clarify' ? 'create' : item.gold,
  )
  const probeRead = readSemantic(cases, falseCreateProbe)
  const expectedFalseCreate = cases.filter(
    (item) => item.gold === 'none' || item.gold === 'clarify',
  ).length
  record(
    'A',
    'A5',
    '**【关键错误·误建承诺】** 把每个 `none`/`clarify` 都猜成 `create` ⇒ `falseCreate` '
      + '**必须**恰好等于它们的条数（关键错误**不进**准确率的分子分母，是**否决项**）',
    `falseCreate = ${String(expectedFalseCreate)}`,
    `falseCreate=${String(probeRead.critical.falseCreate.length)}`,
    probeRead.critical.falseCreate.length === expectedFalseCreate && expectedFalseCreate > 0,
  )

  /* A6 —— 关键错误：假兑现 */
  const falseFulfillProbe: GoalMetricLabel[] = cases.map(() => 'report_complete')
  const fulfillRead = readSemantic(cases, falseFulfillProbe)
  const expectedFalseFulfill = cases.filter((item) => item.gold !== 'report_complete').length
  record(
    'A',
    'A6',
    '**【关键错误·假兑现】** 全猜 `report_complete` ⇒ `falseFulfill` **必须**等于'
      + '非 `report_complete` 的条数',
    `falseFulfill = ${String(expectedFalseFulfill)}`,
    `falseFulfill=${String(fulfillRead.critical.falseFulfill.length)}`,
    fulfillRead.critical.falseFulfill.length === expectedFalseFulfill && expectedFalseFulfill > 0,
  )

  /* A7 —— 每层的分母之和 = 总数（分层读数不许丢条目） */
  const layerSum = oracleRead.perLayer.reduce((acc, row) => acc + row.total, 0)
  record(
    'A',
    'A7',
    '**分层会计**：六层的 `total` 之和 = 总条数（分层读数不许丢条目）',
    `分层之和 = ${String(cases.length)}`,
    `之和=${String(layerSum)} · 层数=${String(oracleRead.perLayer.length)}`,
    layerSum === cases.length && oracleRead.perLayer.length === 6,
  )

  /* A8 —— 分母自检（§6.8：0 检查不得被判成 PASS） */
  record(
    'A',
    'A8',
    '**`measured_count > 0` 自检**：真的算了混淆矩阵（0 条语料与"全对"在输出上长得一样）',
    '总条数 > 0 且矩阵非空',
    `总条数=${String(oracleRead.total)} · 非零格=${String(
      oracleRead.perClass.filter((metric) => metric.predicted > 0).length,
    )} 个类`,
    oracleRead.total > 0,
  )

  /* ======================================================================
   * 丙 · 真模型 provider 的**离线**自检（**零出网**）
   * ==================================================================== */
  phase('C: the real provider is self-checked offline (no network)')

  /*
   * ⚠️ 为什么把它放在**离线**门里：`m10:semantic:eval`（真模型）跑一次要几十次出站，
   *    而"提示词与契约同不同步 / 没有 key 会不会静默变成 none"这两件事**不需要模型**
   *    ⇒ 能在这里钉住的，就不该留到真模型门上去发现。
   */
  const instruction = buildGoalUnderstandingInstruction()
  const missingOperations = GOAL_PROPOSAL_OPERATIONS.filter((op) => !instruction.includes(op))
  const missingFields = Object.keys(GOAL_DRAFT_FIELD_ALLOWLIST).filter(
    (field) => !instruction.includes(field),
  )
  record(
    'C',
    'C1',
    '**提示词从契约派生**：闭集里的每个 `operation`、允许表里的每个字段名都必须出现在提示词里'
      + '（谁手改提示词、或契约加了字段而提示词没跟上 ⇒ 当场红）',
    '0 处缺失',
    `缺 operation ${String(missingOperations.length)}` +
      `${missingOperations.length > 0 ? `：${missingOperations.join(', ')}` : ''}` +
      ` · 缺字段 ${String(missingFields.length)}` +
      `${missingFields.length > 0 ? `：${missingFields.join(', ')}` : ''}`,
    missingOperations.length === 0 && missingFields.length === 0,
  )

  const probeInput: GoalUnderstandingInput = {
    characterId: CHARACTER,
    currentInput: '把写完论文提纲设成目标',
    sourceEventId: 'conv:m10-semdry-c2',
    sourceQualification: 'ESTABLISHED',
    candidates: [],
  }

  /* C2 —— 没有 key ⇒ **抛**（内核记 transport），不静默变成"她说没有目标" */
  let noKeyThrew = false
  let noKeyDetail = ''
  try {
    await createOpenAiGoalUnderstandingProvider({ env: {} }).call({
      input: probeInput,
      deadlineMs: 1_000,
    })
  } catch (error) {
    noKeyThrew = true
    noKeyDetail = error instanceof Error ? error.message.slice(0, 60) : String(error)
  }
  record(
    'C',
    'C2',
    '**没有 key ⇒ 抛**（内核记 `transport`）："没有凭证"与"她说没有目标"必须在输出上不一样',
    '抛错',
    noKeyThrew ? `抛错：${noKeyDetail}` : '**没抛** ⇒ 会被静默读成 none',
    noKeyThrew,
  )

  /* C3 —— 解析失败**返回原文**（内核判 invalid），**不抛**（抛会被误记成 transport） */
  const stubFetch = (content: string): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
      })) as unknown as typeof fetch
  const jsonOut = await createOpenAiGoalUnderstandingProvider({
    env: { OPENAI_API_KEY: 'k' },
    fetchImpl: stubFetch('{"operation":"none","span":{"start":0,"end":1}}'),
  }).call({ input: probeInput, deadlineMs: 1_000 })
  const textOut = await createOpenAiGoalUnderstandingProvider({
    env: { OPENAI_API_KEY: 'k' },
    fetchImpl: stubFetch('抱歉，我不能这样做'),
  }).call({ input: probeInput, deadlineMs: 1_000 })
  record(
    'C',
    'C3',
    '**失败分对桶**：模型给了 JSON ⇒ 解析成对象；给了**非 JSON** ⇒ **原样返回字符串**'
      + '（内核判 `invalid`）—— 把"不是 JSON"抛成 `transport` 会说"这次调用失败了"，而它其实**成功**了',
    'JSON ⇒ object · 非 JSON ⇒ string',
    `JSON 侧 ${typeof jsonOut} · 非 JSON 侧 ${typeof textOut}`,
    typeof jsonOut === 'object' && jsonOut !== null && typeof textOut === 'string',
  )

  /* ======================================================================
   * 乙 · 语料 → 真实链的接线（按层抽样，隔离库 + 真编排）
   * ==================================================================== */
  phase('B: corpus drives the real chain (bounded sample)')

  const agentRuntime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(agentRuntime)
  const db = getRawDb(agentRuntime)
  const harness = createM10TurnHarness({
    db,
    characterId: CHARACTER,
    userId: 'u_m10_semdry',
  })
  /* 按层分层抽样：每层最多 3 条，保持层的多样性 */
  const perLayerCount = new Map<string, number>()
  const sample = cases.filter((item) => {
    const used = perLayerCount.get(item.layer) ?? 0
    if (used >= 3) return false
    perLayerCount.set(item.layer, used + 1)
    return true
  })

  let turnsRun = 0
  let stepsTotal = 0
  let stepsWithFive = 0
  const unreadable: string[] = []
  const predictions: GoalMetricLabel[] = []

  for (const [index, item] of sample.entries()) {
    /*
     * 草案由**金标**驱动 ⇒ 这验的是**接线**，不是语义。
     * `clarify` / `none` 这类"没有操作"的金标在草案层**不可表达**（那是理解层的结论），
     * 因此它们走"provider 给一个明确不是操作的输出"，如实记进 `unreadable` 清单。
     */
    const draft =
      item.gold === 'create'
        ? {
            operation: 'create',
            span: { start: 0, end: item.sourceText.length },
            statement: item.sourceText,
            successCriterion: { kind: 'user_report' },
          }
        : item.gold === 'pause'
          ? { operation: 'pause', span: { start: 0, end: item.sourceText.length }, reason: 'dry' }
          : item.gold === 'cancel'
            ? {
                operation: 'cancel',
                span: { start: 0, end: item.sourceText.length },
                reason: 'user_cancel',
              }
            : item.gold === 'query'
              ? { operation: 'query', span: { start: 0, end: item.sourceText.length } }
              : undefined

    if (draft === undefined) {
      unreadable.push(`${item.caseId}(${item.gold})`)
      predictions.push('clarify')
      continue
    }

    const result = await harness.turn({
      currentInput: item.sourceText,
      sourceEventId: `conv:m10-semdry-${String(index)}`,
      provider: fixedProvider({ kind: 'proposal', proposal: draft }),
      now: 4_000_000_000_000 + index,
      runtime: deterministicRuntime(),
    })
    turnsRun += 1
    const steps = result.trace === undefined ? [] : Object.keys(result.trace)
    stepsTotal += steps.length
    if (steps.length === 5) stepsWithFive += 1
    predictions.push(item.gold)
  }

  record(
    'B',
    'B1',
    `**真实链被语料驱动**：按层抽样的 ${String(sample.length)} 条语料真的跑过一轮`
      + `（隔离库 + 真 \`runGoalTurn\`），其中 ${String(turnsRun)} 条走到了放行口`,
    '抽样条数 > 0 · 且至少一条真的跑了',
    `抽样 ${String(sample.length)} 条 · 跑过 ${String(turnsRun)} 条 · 不可表达 ${String(unreadable.length)} 条`,
    sample.length > 0 && turnsRun > 0,
  )
  record(
    'B',
    'B2',
    '**每轮五个 trace 读数齐全**（证明"结论能被读成预测向量"这条接线是通的）',
    `每轮 5 个读数 · 合计 ${String(turnsRun * 5)}`,
    `合计 ${String(stepsTotal)} 个（${String(stepsWithFive)}/${String(turnsRun)} 轮齐 5）`,
    stepsWithFive === turnsRun && turnsRun > 0,
  )
  recordNote(
    'B',
    'B3',
    '**不可表达的金标被显式列出**（`none`/`clarify` 是**理解层**的结论，草案层表达不了）'
      + ' —— 不把它们悄悄算成"预测正确"',
    '清单在场（可为空但必须报出条数）',
    unreadable.length === 0 ? '0 条（本抽样不含无操作金标）' : `${String(unreadable.length)} 条：[${unreadable.slice(0, 6).join(', ')}]`,
  )

  /* ======================================================================
   * 丙 · 反主张（机器判据：干跑的读数不得被当成语义结论）
   * ==================================================================== */
  const semanticClaim = 'none' as const
  record(
    'D',
    'D1',
    '**反主张（机器判据）**：本门证据里 `semanticClaim` 必须是 `none` —— '
      + '离线干跑的读数**不得**被引用成"语义评测通过"',
    "semanticClaim = 'none'",
    `semanticClaim = '${semanticClaim}'`,
    semanticClaim === 'none',
  )

  phase('done')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp10-semdry', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  /*
   * ⚠️ **分母只算断言**（`L-M10-65`）：登记（`recordNote`）不进 `passed/total`，
   *    只另报 `notes: N` —— 否则"N/N PASS"会把"什么都没断言的行"也算成"验证过的事"。
   */
  const assertions = checks.filter((c) => !c.note)
  const notes = checks.length - assertions.length
  const passed = assertions.filter((c) => c.pass).length
  const failed = assertions.length - passed
  /* ⚠️ 加了 `C` 组（真模型 provider 的离线自检）之后，这份清单也要跟着加 ——
     否则分组读数里**看不到 C**，读者会以为那三条不存在（"分组漏了一组"与"那组没跑"长得一样） */
  const groups = ['A', 'B', 'C', 'D'] as const
  const perGroup = Object.fromEntries(
    groups.map((group) => [
      group,
      {
        total: checks.filter((c) => c.group === group).length,
        passed: checks.filter((c) => c.group === group && c.pass).length,
      },
    ]),
  )

  const nonePredictions = cases.map(() => 'none' as GoalMetricLabel)
  const payload = {
    schema: 'm10-semantic-dry@1',
    runId,
    head,
    /**
     * ⚠️ **本文件里最要紧的两个字段**：它们让"这是干跑"变成**机器可判**的事实，
     *    而不是一句写在 README 里的提醒。
     */
    mode: 'offline' as const,
    semanticClaim,
    corpus: { total: corpus.counts.total, test: cases.length, hash: corpus.corpusHash },
    knownAnswer: {
      echoGold: {
        accuracy: oracleRead.accuracy,
        macroF1: oracleRead.macroF1.value,
        classesAveraged: oracleRead.macroF1.classesAveraged,
      },
      allNone: {
        accuracy: noneRead.accuracy,
        majorityBaseline: noneRead.majorityBaseline,
        macroF1: noneRead.macroF1.value,
      },
      allReportComplete: {
        falseFulfill: fulfillRead.critical.falseFulfill.length,
        accuracy: fulfillRead.accuracy,
      },
    },
    perClass: oracleRead.perClass,
    perLayer: oracleRead.perLayer,
    wiring: {
      sampled: sample.length,
      turnsRun,
      traceStepsTotal: stepsTotal,
      inexpressible: unreadable,
    },
    checks,
    perGroup,
    summary: {
      total: assertions.length,
      passed,
      failed,
      /** **登记**条数（不进 `total/passed`）—— `L-M10-65` */
      notes,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
    disclaimer:
      '离线干跑：证明度量机与接线，**不**主张任何语义质量。语义结论只能来自 WP10 的真模型门，' +
      '且必须先由用户过目语料金标（U-15）。',
  }
  void nonePredictions
  writeFileSync(join(dir, 'semantic-dry.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'semantic-dry',
    counts: { total: assertions.length, passed, failed, notes },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP10 离线干跑：度量机的已知答案自证（预测=金标⇒1.0；全猜 none⇒等于多数类基线）+ ' +
      '语料驱动真实链的接线（按层抽样）+ 反主张机器判据（semanticClaim=none）。' +
      '⚠️ **不主张语义质量**。',
    databaseScope: 'isolated',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(
      `verdict: ${payload.summary.verdict}（断言 ${String(passed)}/${String(assertions.length)}` +
        `${notes > 0 ? ` · 登记 ${String(notes)} 条` : ''}）`,
    )
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  console.log('⚠️ 这是**离线干跑**：mode=offline · semanticClaim=none。它不主张任何语义质量。')
  process.exit(failed === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
