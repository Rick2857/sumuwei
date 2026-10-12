/**
 * M6.1 —— **归因修正的回放复核**（只读已落盘读数；零模型调用）。
 *
 * ============================================================================
 *  它在复核什么
 * ============================================================================
 * 用户 2026-09-23 工作单第 4 项：拿 **H-2 / H-5 的真实失败形态**回放一遍，
 * 检查修好之后的判据**确实**把它们归到 `sampling_disagreement`（语义层），
 * 而不是像旧判据那样写成"被传输失败吃掉、根因在传输层"。
 *
 * ```text
 *   输入    某一轮已经落盘的 instrument-live.json（**只读**，绝不改写）
 *   回放    用**当前**的 judgeItem / computeMetrics / evaluateValidity 重新算一遍
 *   输出    artifacts/m6.1/attribution-replay.json（独立文件，不覆盖任何原始证据）
 * ```
 *
 * ============================================================================
 *  为什么这不是"自己证明自己"
 * ============================================================================
 * ```text
 *   ① 回放用的**判定器输出**全部来自原始证据里的 `readings`（那是真实模型给的），
 *      不是重跑出来的、也不是构造的 —— 只有"从读数到结论"这一段是当前的代码。
 *   ② 旧结论**同时**打印出来做对照：同一份输入，旧判据说传输层、新判据说语义层，
 *      两个结论并排展示，读者自己可以核。
 *   ③ 它**不**主张"新判据在真实运行里正确"：那段确定性逻辑不需要再花模型调用去证明，
 *      但也因此**不构成** live 观察 —— 报告里"尚未在 live 观察到"这句话照旧成立。
 * ```
 *
 * 用法：
 * ```bash
 * pnpm m6.1:attribution-replay                        # 默认取最新一轮、最新两轮…
 * pnpm m6.1:attribution-replay -- --run <runId>
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import { ALERT_LABELS, M6_1_CORPUS_VERSION, SPLITS, alertStateOf } from './m6.1-contract.ts'
import {
  INSTRUMENT_VALIDITY_CRITERIA,
  computeMetrics,
  evaluateValidity,
  itemsFromCorpus,
  judgeItem,
  type InstrumentItem,
  type ItemJudgment,
} from './m6.1-instrument.ts'

const ROOT = resolve(process.cwd())
const EVAL_DIR = join(ROOT, 'artifacts', 'm6.1')
const OUT_PATH = join(EVAL_DIR, 'attribution-replay.json')

/** 用户点名的两个条目 + 同轮里同样被误归因的类别，回放后必须改口。 */
const NAMED_ITEMS = ['H-2', 'H-5']

interface ObservationRecord {
  readonly itemId: string
  readonly category: string
  readonly ok: boolean
  readonly callFailure: string | null
  readonly parseFailure: string | null
  readonly predictedLabels: readonly string[]
  readonly expectedLabels: readonly string[]
  readonly predictedAlert: boolean
  readonly expectedAlert: boolean
  readonly readings?: readonly (readonly string[])[]
}

/**
 * 从**已落盘**的观测记录复原 `ItemJudgment`。
 *
 * ⚠️ 复原规则必须与 live 门**当时的口径**一致，因此这里跟着 `CD-14` 走：
 * ```text
 *   ok=true                      ⇒ 两条采样报警性一致且可判（记录的 alertState 优先，其次由标签复算）
 *   ok=false 且 2 条采样          ⇒ 报警性不同 / 两次都没给结论（由标签复算区分）
 *   ok=false 且少于 2 条采样      ⇒ 传输/解析层的那一类码
 * ```
 * **不**在这里做任何推断式的修补：证据缺什么就按缺什么复现。
 * 老证据（contract@2 及以前）里的 `unresolved` 会在下面被显式翻译成 `CD-14` 的口径，
 * 并在回放报告里标注"这是**反事实**分析"。
 */
function judgmentOf(record: ObservationRecord): ItemJudgment {
  const readings = record.readings ?? []
  if (record.ok) {
    const labels = [...record.predictedLabels]
    const state = alertStateOf(labels)
    return {
      itemId: record.itemId,
      ok: state !== 'undecidable',
      ...(state === 'undecidable' ? { failure: 'undecidable_sample' as const } : {}),
      alertState: state,
      predictedAlert: state === 'alert',
      predictedLabels: labels,
      expectedAlert: record.expectedAlert,
      expectedLabels: [...record.expectedLabels],
    }
  }
  if (readings.length >= 2) {
    const states = readings.map((labels) => alertStateOf(labels))
    const distinct = [...new Set(states)]
    const failure =
      distinct.length !== 1
        ? ('alert_state_disagreement' as const)
        : states[0] === 'undecidable'
          ? ('undecidable_both_samples' as const)
          : // 两条采样报警性一致且可判 ⇒ 在 CD-14 下**本来应该**成立读数；
            // 旧证据记成 ok=false（旧口径要求标签集合完全一致）⇒ 这里如实标成
            // "旧口径下的失败"，由回放报告说明它是反事实口径差异。
            ('alert_state_disagreement' as const)
    return {
      itemId: record.itemId,
      ok: false,
      failure,
      alertState: 'undecidable',
      predictedAlert: false,
      predictedLabels: [],
      expectedAlert: record.expectedAlert,
      expectedLabels: [...record.expectedLabels],
    }
  }
  return {
    itemId: record.itemId,
    ok: false,
    failure: (record.callFailure ?? record.parseFailure ?? 'call_failure') as ItemJudgment['failure'],
    alertState: 'undecidable',
    predictedAlert: false,
    predictedLabels: [],
    expectedAlert: record.expectedAlert,
    expectedLabels: [...record.expectedLabels],
  }
}

/**
 * 载入**冻结语料**里的条目，并要求它与那一轮的语料版本**一致**。
 *
 * 为什么不能只从观测记录里"再造"条目：观测记录里没有 `contrast`（对照对），
 * 而 `a==b` / 成对一致性两条防线靠它。第一版把 contrast 丢了，回放就凭空多出
 * 一条 `a_equals_b_not_measured` —— 那是**回放自己的缺陷**，不是原读数的变化。
 * 版本不一致时**失败关闭**：拿新语料回放旧读数，得到的是另一种测量。
 */
function loadCorpusFor(runId: string): Map<string, InstrumentItem> {
  const manifestPath = join(EVAL_DIR, runId, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺清单 ${manifestPath}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { corpusVersion?: string }
  if (manifest.corpusVersion !== M6_1_CORPUS_VERSION) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：${runId} 用的是语料 ${String(manifest.corpusVersion)}，` +
        `当前冻结语料是 ${M6_1_CORPUS_VERSION} ⇒ 回放不可比，拒绝运行（不许拿新语料回放旧读数）`
    )
  }
  const byId = new Map<string, InstrumentItem>()
  for (const split of SPLITS) {
    const abs = join(ROOT, 'evals', 'm6.1', 'corpus', `${split}.jsonl`)
    if (!existsSync(abs)) throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺语料 ${abs}`)
    const rows: unknown[] = []
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line))
    }
    for (const item of itemsFromCorpus(rows)) byId.set(item.itemId, item)
  }
  return byId
}

function parseArgs(argv: readonly string[]): string[] {
  const ids: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--run') continue
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`--run 后面必须是一个 runId（收到 ${String(value)}）`)
    }
    ids.push(value)
    index += 1
  }
  return ids
}

function main(): void {
  const startedAt = new Date().toISOString()
  const requested = parseArgs(process.argv.slice(2))
  if (requested.length === 0) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：必须显式给出 --run <runId>（回放针对**具体某一轮**的真实失败，不自动挑轮次）'
    )
  }

  const replays = requested.map((runId) => {
    const evidencePath = join(EVAL_DIR, runId, 'instrument-live.json')
    if (!existsSync(evidencePath)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺读数 ${evidencePath}`)
    }
    const stored = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      judge?: { promptVersion?: string; promptDigest?: string }
      verdict?: string
      reasons?: { code: string; detail: string }[]
      observations?: ObservationRecord[]
      metrics?: { undecidableByReason?: Record<string, number> }
    }
    const observations = stored.observations ?? []
    if (observations.length === 0) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：${runId} 的 observations 有 0 条 ⇒ 回放无从谈起（"检查了 0 条"不是"通过"）`
      )
    }

    const items = (() => {
      const byId = loadCorpusFor(runId)
      const missing = observations.filter((entry) => !byId.has(entry.itemId)).map((e) => e.itemId)
      if (missing.length > 0) {
        throw new MeasurementInvalidError(
          `MEASUREMENT INVALID：${runId} 有 ${String(missing.length)} 个条目不在当前冻结语料里` +
            `（${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}）⇒ 回放不可比`
        )
      }
      return observations.map((entry) => {
        const found = byId.get(entry.itemId) as InstrumentItem
        return found
      })
    })()
    const judgments = observations.map(judgmentOf)
    const metrics = computeMetrics(items, judgments)
    /*
     * 稳定性与跨轮读数传 `undefined`（= 没提供），**不**传 null：
     * 二者在 `evaluateValidity` 里都会落成"没测到"的失败关闭理由，
     * 而这次回放本来就不重跑探针、也不聚合跨轮 —— 那两条理由与归因修正无关。
     */
    const decision = evaluateValidity(metrics, INSTRUMENT_VALIDITY_CRITERIA, {
      criteriaFrozen: true,
    })

    const storedCodes = (stored.reasons ?? []).map((reason) => reason.code)
    const replayedCodes = decision.reasons.map((reason) => reason.code)
    const named = NAMED_ITEMS.map((itemId) => {
      const record = observations.find((entry) => entry.itemId === itemId)
      if (record === undefined) {
        return { itemId, present: false as const }
      }
      const reason = metrics.undecidableByReason
      return {
        itemId,
        present: true as const,
        category: record.category,
        ok: record.ok,
        parseFailure: record.parseFailure,
        readings: (record.readings ?? []).map((entry) => [...entry]),
        expectedLabels: [...record.expectedLabels],
        replayedClassification:
          record.ok
            ? 'decided'
            : (record.readings ?? []).length >= 2
              ? 'sampling_disagreement（语义层）'
              : String(record.callFailure ?? record.parseFailure ?? 'unknown'),
      }
    })

    /*
     * 自查：回放算出的不可判原因分布**必须**非空，且必须真的含 sampling_disagreement。
     * 否则这次回放什么都没证明（"发现 0 处不一致"与"全都一致"在输出上长得一样）。
     */
    const disagreement = metrics.undecidableByReason.sampling_disagreement ?? 0
    const measured = items.length
    if (measured === 0 || disagreement === 0) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：${runId} 回放后 sampling_disagreement = ${String(disagreement)}、` +
          `measured = ${String(measured)} ⇒ 这次回放没有证明任何事`
      )
    }

    /*
     * ---- 核心断言（失败关闭）----
     *
     * 若那一轮**存着** `category_alert_control_transport_lost`，而它点名的那一类的
     * 应报警条目其实全是 `unresolved` ⇒ 回放**必须**把归因改成语义层。
     * 对不上就说明归因修正没生效（或又退回去了），此时**不许**打印一份"看起来没问题"的报告。
     */
    const storedHadTransportLost = storedCodes.includes('category_alert_control_transport_lost')
    const transportLostCategory = (() => {
      const reason = (stored.reasons ?? []).find(
        (entry) => entry.code === 'category_alert_control_transport_lost'
      )
      if (reason === undefined) return null
      const match = /类别 ([A-Z]) /.exec(reason.detail)
      return match?.[1] ?? null
    })()
    const lostByDisagreement =
      transportLostCategory === null
        ? 0
        : observations.filter(
            (entry) =>
              entry.category === transportLostCategory &&
              entry.expectedAlert &&
              (entry.readings ?? []).length >= 2
          ).length
    const mustBeReattributed = storedHadTransportLost && lostByDisagreement > 0
    const reattributed =
      !replayedCodes.includes('category_alert_control_transport_lost') &&
      replayedCodes.includes('category_alert_control_unjudged')
    if (mustBeReattributed && !reattributed) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：${runId} 的旧读数把类别 ${String(transportLostCategory)} 的正控丢失` +
          `归因成传输层，而回放算出的归类**没有**改成语义层（unjudged=${String(
            replayedCodes.includes('category_alert_control_unjudged')
          )}）⇒ 归因修正没有生效`
      )
    }

    return {
      runId,
      evidencePath: relative(ROOT, evidencePath).split(/[\\/]/).join('/'),
      promptVersion: stored.judge?.promptVersion ?? null,
      promptDigestPrefix: stored.judge?.promptDigest?.slice(0, 12) ?? null,
      storedVerdict: stored.verdict ?? null,
      replayedVerdict: decision.verdict,
      storedUndecidableByReason: stored.metrics?.undecidableByReason ?? null,
      replayedUndecidableByReason: metrics.undecidableByReason,
      storedReasonCodes: storedCodes,
      replayedReasonCodes: replayedCodes,
      /**
       * 旧读数里**明确写错归因**的那些码，回放后**不该**再出现。
       * 这是本节要主张的核心事实，所以做成机器判据而不是一段叙述。
       */
      correctedAttribution: {
        oldCode: 'category_alert_control_transport_lost',
        wasPresentWhenStored: storedCodes.includes('category_alert_control_transport_lost'),
        isPresentWhenReplayed: replayedCodes.includes('category_alert_control_transport_lost'),
        newCode: 'category_alert_control_unjudged',
        isPresentWhenReplayed2: replayedCodes.includes('category_alert_control_unjudged'),
        namedCategory: transportLostCategory,
        itemsLostToSamplingDisagreement: lostByDisagreement,
        mustBeReattributed,
        assertionPassed: !mustBeReattributed || reattributed,
      },
      measuredItems: measured,
      samplingDisagreementCount: disagreement,
      namedItems: named,
      notClaimed: [
        '本次回放**只**重算"从已落盘判定结果到结论"这一段；它没有调用模型、没有重建提示。',
        '它**不**构成 live 观察：报告里"归因修复尚未在 live 观察到"这句话照旧成立。',
        '稳定性 / 跨轮读数一律传 null ⇒ 回放 verdict 里的那两条理由必然出现，' +
          '它们与归因修正无关，不得据此读成"回放发现新问题"。',
      ],
    }
  })

  const evidence = {
    schemaVersion: 'm6.1-attribution-replay@1',
    testId: 'M6.1 归因修正的回放复核（只读已落盘读数；零模型调用）',
    scope:
      '用**当前**的 computeMetrics / evaluateValidity 重放历轮里已记录的判定结果，' +
      '检查"某类应报警条目全因语义分歧不可判"是否被归到 sampling_disagreement 而不是传输层。',
    startedAt,
    finishedAt: new Date().toISOString(),
    replays,
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  console.log('='.repeat(78))
  console.log('M6.1 归因修正的回放复核（只读；零模型调用）')
  console.log('='.repeat(78))
  for (const replay of replays) {
    console.log(`\n轮次 ${replay.runId}（${replay.promptVersion ?? '(未记录)'}#${replay.promptDigestPrefix ?? '??'}）`)
    console.log(`  回放条目数      ${String(replay.measuredItems)}`)
    console.log(`  存储的 verdict  ${String(replay.storedVerdict)}`)
    console.log(`  回放的 verdict  ${String(replay.replayedVerdict)}`)
    console.log(`  存储的不可判原因 ${JSON.stringify(replay.storedUndecidableByReason)}`)
    console.log(`  回放的不可判原因 ${JSON.stringify(replay.replayedUndecidableByReason)}`)
    console.log(`  抽样分歧条数    ${String(replay.samplingDisagreementCount)}（回放后必须 > 0，否则本次回放无效）`)
    console.log(`  存储的理由码    ${JSON.stringify(replay.storedReasonCodes)}`)
    console.log(`  回放的理由码    ${JSON.stringify(replay.replayedReasonCodes)}`)
    const fix = replay.correctedAttribution
    console.log(
      `  归因对照        存储里有 ${fix.oldCode} = ${String(fix.wasPresentWhenStored)} ⇒ ` +
        `回放后有 ${fix.oldCode} = ${String(fix.isPresentWhenReplayed)}、` +
        `${fix.newCode} = ${String(fix.isPresentWhenReplayed2)}`
    )
    for (const named of replay.namedItems) {
      if (!named.present) {
        console.log(`  ${named.itemId} 不在这一轮里`)
        continue
      }
      console.log(
        `  ${named.itemId} [${named.category}] parseFailure=${String(named.parseFailure)} ⇒ ` +
          `回放归类 ${named.replayedClassification}`
      )
      for (const reading of named.readings) console.log(`      采样 [${reading.join('+')}]`)
    }
  }
  console.log(`\n证据：${relative(ROOT, OUT_PATH).split(/[\\/]/).join('/')}`)
  console.log(
    '\n⚠️ 本回放**不**构成 live 观察：它只用已落盘的判定结果重算归因逻辑。' +
      '报告里"归因修复尚未在 live 观察到"照旧成立。'
  )
  console.log(
    '（回放**不提供** stability / crossRun 读数 ⇒ verdict 里会照旧出现 ' +
      'stability_not_measured 与 cross_run_not_measured 两条理由。它们与归因修正无关，' +
      '不得据此读成"回放发现了新问题"。）'
  )
  console.log(`\nALERT_LABELS 量具口径核对：${ALERT_LABELS.join(', ')}`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-attribution-replay] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-attribution-replay] 这是 MEASUREMENT INVALID，不是"没问题"')
  }
  process.exit(2)
}
