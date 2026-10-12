/**
 * M6.1 **WP3 判定读数** —— 用**冻结量具**去读 WP3 基线场景的回复。
 *
 * ============================================================================
 *  它在回答计划书 §WP3 的第一句
 * ============================================================================
 * > 先在**未修复候选**用新契约与有效量具跑基线。
 *
 * `m6.1-baseline.ts` 采到了回复（**未修复候选**、生产装配本尊），但"采到回复"不等于
 * "用有效量具跑过"。本脚本补的就是这一步：把每一轮回复连同**三套事实**喂给
 * 契约 @4 的冻结判定器，取两次采样，按 `CD-14` 的规则形成读数。
 *
 * ============================================================================
 *  三条不许含糊的边界
 * ============================================================================
 * ```text
 * ① **只出读数，不出度量**：WP3 的合成场景**没有人工标注** ⇒ 没有"召回率 / 误报率"
 *    可算。`computeMetrics` 需要 `expectedLabels`，本脚本**不调用它**，也不写任何
 *    准确率 —— 阈值与机器门是计划书 §7 明列的**人工裁定项**。
 *    给出的 `expectedLabels: []` 只是 `InstrumentItem` 的形状要求，**不是标注**，
 *    因此证据里一律不打印它。
 * ② **第 ③ 套事实是"结构性重建"**：判定契约 §3.1 的 `actualContext` 本应是"她这一轮
 *    真正看到的"。产品 trace **刻意不记提示正文**（无泄漏白名单）⇒ 本脚本只能从
 *    `context_compile` / `memory_recall` 两步还原 **section 名 + 计数 + 选中记忆 id**，
 *    并**自报**这是结构性重建。凡 trace 缺 `context_compile` 的轮次，第 ③ 套事实
 *    写 `null` + 具名原因（契约 §3 的机器判据），**不编**一份"她大概看到了什么"。
 * ③ **判定的字节必须是被记录的字节**：逐轮重算 `sha256(回复)` / `sha256(用户原话)`，
 *    与 `baseline.json` 里落的哈希对不上就 **MEASUREMENT INVALID**（拒绝判）。
 *    "我判的是不是当时那一句"不靠注释保证，靠哈希。
 * ```
 *
 * ============================================================================
 *  它为什么能主张"用的是**同一件**量具"
 * ============================================================================
 * 判定提示的正文自己进摘要（`probePromptDigest` 折的是**探针集**）。本脚本在开工前
 * 用**当前代码**重算一遍探针摘要，与冻结值逐字比对：
 * ```text
 *   相等   ⇒ 提示正文与冻结轮**逐字同一**（改一个字摘要就变），可以主张"同一件量具"
 *   不等   ⇒ 拒绝运行（那时"用有效量具跑基线"这句话就是假的）
 * ```
 * ⚠️ 但**不**主张 `configKey` 与验收轮相同：`configKey` 里含 `maxTokens` 与契约版本，
 *    本轮是 `contract@4` + `maxTokens=32000` + `reasoning=low`，与冻结轮一致；
 *    而"跨轮稳定性"那条判据要求**同探针集**，本脚本不吃它（读数不是验收读数）。
 *
 * 用法：
 * ```bash
 * pnpm with-test-model pnpm m6.1:wp3:judge -- --run <基线 runId> [--run <另一个>]
 * pnpm with-test-model pnpm m6.1:wp3:judge -- --run <runId> --dry-run   # 只组装、零调用
 * ```
 */

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { probePromptDigest } from './m6.1-cross-run-core.ts'
import {
  M6_1_LOCAL_PARENT,
  createRunId,
  openRunDir,
  sha256OfText,
  writeManifestAtomic,
} from './m6.1-evidence.ts'
import { standardManifestFields } from './m6.1-run-manifest.ts'
import {
  M6_1_JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  itemsFromCorpus,
  judgmentFromSamples,
  type InstrumentItem,
  type ParseOutcome,
} from './m6.1-instrument.ts'
import {
  M6_1_JUDGE_MAX_TOKENS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  M6_1_JUDGE_REASONING_EFFORT,
  createOpenAiInstrumentJudge,
  type JudgeCallResult,
} from './m6.1-judge-openai.ts'

const ROOT = resolve(process.cwd())

/* 清单公共字段用（L-M61-14）：进程开始时刻 + 实际命令行（`standardManifestFields()` 不读 argv）。 */
const STARTED_AT = new Date().toISOString()
const INVOKED_COMMAND = `pnpm with-test-model pnpm m6.1:wp3:judge ${process.argv.slice(2).join(' ')}`.trim()

/**
 * 冻结量具的**探针口径**提示摘要（`m6.1-judge-prompt@4`）。
 *
 * 出处：`docs/m6.1/M6.1-Instrument-Validity-Report.md` §22 与验收两轮的
 * `instrument-live.json` 的 `judge.promptDigest`；候选冻结（`480e844ac49b`）里也记着它。
 * 它是"提示正文没有变过"的**机器判据**：本脚本每次开工都重算并比对。
 */
const FROZEN_PROBE_PROMPT_DIGEST =
  'd67bda94d4fb199c4cf66c26158ee185c088eff4360225dc6481ff021c2a6539'

/**
 * 每条读数的采样次数。
 *
 * ⚠️ 必须与 `m6.1-instrument-live.ts` 的 `READINGS_PER_ITEM` 相同 —— 那是 `CD-10`
 *    冻结的读数定义（"同一输入判两次"）。这里写成常量并**在开工时断言**，
 *    而不是从别处 import：那个常量在 live 门里是模块私有的，为它改冻结门不划算，
 *    而这个数一旦被谁改动，`judgmentFromSamples` 的语义就跟着变，必须有具名断言守着。
 */
const SAMPLES_PER_ITEM = 2

/** 与 live 门同一条守卫：必须经测试包装器，否则可能烧 `.env` 的原 Key。 */
function assertTestWrapper(): void {
  if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
    throw new Error(
      `失败关闭：缺 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝运行。` +
        '本门必须经 `pnpm with-test-model` 跑（绝不回落到 .env 的原 key）。'
    )
  }
}

function argsOf(name: string): string[] {
  const out: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue
    const value = process.argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 缺参数值`)
    out.push(value)
  }
  return out
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function readJsonLines(path: string): unknown[] {
  const rows: unknown[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    rows.push(JSON.parse(line))
  }
  return rows
}

interface BaselineTurnRow {
  readonly id: string
  readonly category: string
  readonly note?: string
  readonly userText: string
  readonly reply: string
  readonly replyStatus?: number
  readonly stateViews?: Record<string, string>
}

interface BaselineReading {
  readonly runId: string
  readonly arm: string
  readonly armNote?: string
  readonly rollupTokens?: number
  readonly diagnostic?: boolean
  readonly scenario: readonly { readonly id: string; readonly note?: string; readonly textSha256: string }[]
  readonly turns: readonly {
    readonly id: string
    readonly category: string
    readonly userTextSha256: string
    readonly replySha256: string
    readonly replyChars: number
    readonly memoryListEmpty?: boolean
  }[]
}

interface TurnTraceReadout {
  readonly order: number
  readonly traceId: string
  readonly startedAt: string
  readonly contextCompile: Record<string, unknown> | null
  readonly memoryRecall: Record<string, unknown> | null
  readonly explicitWrite: { readonly status: string; readonly attributes: Record<string, unknown> } | null
}

interface TraceReadoutFile {
  readonly runId: string
  readonly turnTraceNote?: string
  readonly traceCount: number
  readonly turns?: readonly TurnTraceReadout[]
}

// ---------------------------------------------------------------------------
// 视图正文抽取（只取"人看的那一段"，丢掉启动日志与收尾日志）
// ---------------------------------------------------------------------------

/**
 * 从只读状态视图的 stdout 里取出正文段。
 *
 * ⚠️ 为什么不用整段 stdout：每个视图前面有 ~1.5KB 的启动日志、后面有收尾日志，
 *    整段塞进判定提示会把三套事实淹掉，而且那两段与本判定**无关**。
 *    这一步是**纯裁剪**（不生成、不改写）：起点 = 含 `marker` 的那行之后跳过 `====` 分隔线，
 *    终点 = 第一个 `⚠️` / ` Info ` / `◇` 开头的行。裁不到 ⇒ 返回 `null`（**不**返回空串冒充）。
 */
function viewBody(view: string | undefined, marker: string): string | null {
  if (view === undefined) return null
  const lines = view.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes(marker))
  if (start === -1) return null
  let rest = lines.slice(start + 1)
  while (rest.length > 0 && /^=+\s*$/.test(rest[0] ?? '')) rest = rest.slice(1)
  const body: string[] = []
  for (const line of rest) {
    if (/^⚠️/.test(line) || /^ Info /.test(line) || /^◇/.test(line)) break
    body.push(line)
  }
  const text = body.join('\n').trim()
  return text === '' ? null : text
}

// ---------------------------------------------------------------------------
// 三套事实的组装
// ---------------------------------------------------------------------------

/**
 * 第 ③ 套事实：**结构性重建**（见文件头 ②）。
 *
 * 只放 trace 里**真有**的东西。`rollup` 段只在那一轮真出现过 `rollup_*` 键时才给 ——
 * 缺键**不是**"摘要跑了但没扫到"，而是"这一轮摘要端口根本没被咨询"（两档预算的差别
 * 就长在这里），所以缺键必须记成 `null` 而不是一串 0。
 */
function buildActualContext(trace: TurnTraceReadout | undefined): {
  readonly value: Record<string, unknown> | null
  readonly unavailableReason?: string
} {
  if (trace === undefined) {
    return { value: null, unavailableReason: 'trace_readout_missing_turn' }
  }
  const contextCompile = trace.contextCompile
  const recall = trace.memoryRecall
  if (contextCompile === null && recall === null) {
    return { value: null, unavailableReason: 'trace_missing_context_compile_and_recall' }
  }
  const rollupKeys = Object.keys(contextCompile ?? {}).filter((key) => key.startsWith('rollup_'))
  return {
    value: {
      kind: 'structural-reconstruction-from-product-trace',
      traceId: trace.traceId,
      traceStartedAt: trace.startedAt,
      /**
       * ⚠️ 这句话必须跟着数据一起走：判定器看到的"她看到了什么"是结构读数，
       *    不是逐字提示。**不得**在报告里把它说成"逐字重放"。
       */
      caveat:
        'trace 只记 section **名字**、预算计数与选中记忆 **id**；逐字提示正文**不在** trace 里' +
        '（无泄漏白名单）。因此这是"结构性重建"，不是逐字上下文。',
      sections: contextCompile === null ? null : String(contextCompile.sections ?? '').split(',').filter(Boolean),
      droppedSections: contextCompile?.dropped ?? null,
      estimatedTokens: contextCompile?.estimatedTokens ?? null,
      identityIncluded: contextCompile?.identityIncluded ?? null,
      rollup: rollupKeys.length === 0 ? null : Object.fromEntries(rollupKeys.map((k) => [k, contextCompile?.[k]])),
      recall:
        recall === null
          ? null
          : {
              scanned: recall.scanned ?? null,
              candidateCount: recall.candidates ?? null,
              eligibleCount: recall.eligible ?? null,
              selectedCount: recall.selected ?? null,
              droppedByBudget: recall.droppedByBudget ?? null,
              reachedContext: recall.reachedContext ?? null,
              exclusions: recall.exclusions ?? null,
              /** **实际进了 packet** 的记忆 id（`decisionRecord.selectedIds` 是事实） */
              selectedIds: recall.selectedIds ?? null,
            },
      explicitWriteThisTurn:
        trace.explicitWrite === null
          ? null
          : { status: trace.explicitWrite.status, ...trace.explicitWrite.attributes },
    },
  }
}

interface AssembledItem {
  readonly itemId: string
  readonly turnId: string
  readonly category: string
  readonly item: InstrumentItem
  readonly prompt: string
  readonly promptSha256: string
  readonly responseChars: number
  readonly facts: {
    readonly factBaseAvailable: boolean
    readonly eligibleStateAvailable: boolean
    readonly actualContextAvailable: boolean
    readonly actualContextUnavailableReason?: string
  }
}

function assembleItems(options: {
  readonly runId: string
  readonly reading: BaselineReading
  readonly turns: readonly BaselineTurnRow[]
  readonly trace: TraceReadoutFile
}): { readonly items: AssembledItem[]; readonly problems: string[] } {
  const problems: string[] = []
  const turnList = options.trace.turns ?? []
  if (turnList.length !== options.turns.length) {
    problems.push(
      `trace 轮数 ${String(turnList.length)} ≠ 回复轮数 ${String(options.turns.length)}` +
        '（对应关系不成立 ⇒ 不许把第 ③ 套事实配上别的轮次）'
    )
  }
  const assembled: AssembledItem[] = []
  for (const [index, turn] of options.turns.entries()) {
    const trace = turnList[index]
    /* ---- 脚本底稿：到这一轮为止的全部用户原话（合成剧情，不是真实轨迹） ---- */
    const script = options.turns.slice(0, index + 1).map((row, position) => ({
      turn: position + 1,
      turnId: row.id,
      userSaid: row.userText,
    }))
    const memoryList = viewBody(turn.stateViews?.memoryList, 'Memory 列表')
    const ledger = viewBody(turn.stateViews?.kernelStatus, '事实账本')
    const actual = buildActualContext(trace)

    const item: InstrumentItem = {
      itemId: `wp3-${options.runId.slice(-4)}-${turn.id}`,
      category: String(turn.category),
      responseText: turn.reply,
      evidence: {
        factBase: {
          kind: 'synthetic-scenario-script',
          note:
            '**重建合成案例**：合成隔离库从**空**开始，除下列用户原话之外**没有**任何既有共同历史。' +
            '底稿仅供核对，**不代表她当轮看见了这些**。',
          userTurnsSoFar: script,
        },
        eligibleState: {
          kind: 'product-ledger-and-memory-list',
          note: '账本（`conversation_events`）与 `memory:list` 正文，取自**当轮**只读状态视图。',
          conversationLedger: ledger,
          memoryList,
        },
        actualContext: actual.value,
        ...(actual.unavailableReason === undefined
          ? {}
          : { actualContextUnavailableReason: actual.unavailableReason }),
      },
      /*
       * ⚠️ 这里**没有**人工标注：本场景是根因探针，不是标注语料。
       *    `expectedLabels: []` / `expectedAlert: false` 只是形状占位，
       *    本脚本**不**把它当答案、**不**算任何度量、证据里也**不**打印它。
       */
      expectedLabels: [],
      expectedAlert: false,
    }
    const prompt = buildJudgePrompt(item)
    assembled.push({
      itemId: item.itemId,
      turnId: turn.id,
      category: String(turn.category),
      item,
      prompt,
      promptSha256: sha256OfText(prompt),
      responseChars: turn.reply.length,
      facts: {
        factBaseAvailable: script.length > 0,
        eligibleStateAvailable: ledger !== null || memoryList !== null,
        actualContextAvailable: actual.value !== null,
        ...(actual.unavailableReason === undefined
          ? {}
          : { actualContextUnavailableReason: actual.unavailableReason }),
      },
    })
  }
  return { items: assembled, problems }
}

// ---------------------------------------------------------------------------
// 读数形成（与 live 门同一条路径）
// ---------------------------------------------------------------------------

interface SampleRecord {
  readonly callFailure: string | null
  readonly httpStatus: number | null
  readonly finishReason: string | null
  readonly rawLength: number
  readonly durationMs: number
  readonly attempts: number
  readonly parsedOk: boolean
  readonly labels: readonly string[]
  readonly quotes: readonly string[]
}

interface PassObservation {
  readonly itemId: string
  readonly turnId: string
  readonly category: string
  readonly ok: boolean
  readonly alertState: string
  readonly predictedLabels: readonly string[]
  readonly failure: string | null
  readonly undecidableCause: string | null
  readonly samples: readonly (readonly string[])[]
  readonly callFailure: string | null
  readonly sampleRecords: readonly SampleRecord[]
}

type JudgeFn = (prompt: string) => Promise<JudgeCallResult>

/**
 * 跑一遍读数（**与 `m6.1-instrument-live.ts` 的主循环同语义**）。
 *
 * 刻意复刻而不是 import：那个循环长在冻结门的 `main()` 里。复刻的部分只有
 * 采样次数、限流节奏、失败计数三件事，而它们都被下面的 self-test 三段式守着。
 */
async function runPass(options: {
  readonly items: readonly AssembledItem[]
  readonly judge: JudgeFn
  readonly minIntervalMs: number
}): Promise<{
  readonly observations: PassObservation[]
  readonly callFailureTally: Record<string, number>
  readonly calls: number
  readonly durationMs: number
}> {
  const observations: PassObservation[] = []
  const callFailureTally: Record<string, number> = {}
  let calls = 0
  const startedAt = Date.now()

  for (const [index, entry] of options.items.entries()) {
    const samples: string[][] = []
    const sampleRecords: SampleRecord[] = []
    let transportFailure: string | null = null
    for (let reading = 0; reading < SAMPLES_PER_ITEM; reading += 1) {
      if (index > 0 || reading > 0) {
        await new Promise<void>((resolveP) => setTimeout(resolveP, options.minIntervalMs))
      }
      const result = await options.judge(entry.prompt)
      calls += result.attempts
      if (result.callFailure !== null) {
        callFailureTally[result.callFailure] = (callFailureTally[result.callFailure] ?? 0) + 1
        transportFailure = transportFailure ?? result.callFailure
        sampleRecords.push({
          callFailure: result.callFailure,
          httpStatus: result.httpStatus,
          finishReason: result.finishReason,
          rawLength: result.rawLength,
          durationMs: result.durationMs,
          attempts: result.attempts,
          parsedOk: false,
          labels: [],
          quotes: [],
        })
        continue
      }
      const parsed = result.parsed ?? { ok: false as const, failure: 'empty' as const, detail: '呼叫未成功' }
      const labels = parsed.ok ? [...new Set(parsed.output.assertions.map((a) => a.label))].sort() : []
      sampleRecords.push({
        callFailure: null,
        httpStatus: result.httpStatus,
        finishReason: result.finishReason,
        rawLength: result.rawLength,
        durationMs: result.durationMs,
        attempts: result.attempts,
        parsedOk: parsed.ok,
        labels,
        quotes: parsed.ok ? parsed.output.assertions.map((a) => a.quote) : [],
      })
      if (!parsed.ok) {
        /*
         * 采样**拿到了**但没给结论（空断言集 / 显式 INDETERMINATE）是**语义层**，
         * 不是传输失败 —— 与 live 门同一条归因（那里为这条纪律返工过一次）。
         */
        samples.push([])
        continue
      }
      samples.push(labels)
    }
    const judgment = judgmentFromSamples(entry.item, samples, transportFailure, SAMPLES_PER_ITEM)
    observations.push({
      itemId: entry.itemId,
      turnId: entry.turnId,
      category: entry.category,
      ok: judgment.ok,
      alertState: judgment.alertState,
      predictedLabels: judgment.predictedLabels,
      failure: judgment.ok ? null : (judgment.failure ?? null),
      undecidableCause: judgment.undecidableCause ?? null,
      samples,
      callFailure: transportFailure,
      sampleRecords,
    })
  }
  return { observations, callFailureTally, calls, durationMs: Date.now() - startedAt }
}

// ---------------------------------------------------------------------------
// 三段式自证（正控 / 负控 / 恢复）—— 零模型调用
// ---------------------------------------------------------------------------

function fakeCall(parsed: ParseOutcome): JudgeCallResult {
  return {
    ok: parsed.ok,
    parsed,
    callFailure: null,
    httpStatus: 200,
    finishReason: 'stop',
    rawLength: 64,
    attempts: 1,
    durationMs: 1,
    usage: null,
    attemptLog: [],
  }
}

function labelsOf(...labels: string[]): ParseOutcome {
  return { ok: true, output: { assertions: labels.map((label) => ({ quote: '（自证夹具）', label })) } }
}

/**
 * 三段式：合法输入 → 判定器**必须**安静不下来（正控要给读数）；
 * 注入"空断言 / 传输失败" → **必须**响（记成不可判，**不得**记成 no_alert）；
 * 放回正常输入 → 重新稳定。
 *
 * ⚠️ 只做正控的量具与"什么都不检查"在输出上无法区分 —— 所以三段都要有。
 */
async function selfTest(
  items: readonly AssembledItem[]
): Promise<{ readonly ok: boolean; readonly failures: string[]; readonly phases: Record<string, unknown> }> {
  const failures: string[] = []
  if (items.length === 0) return { ok: false, failures: ['自证输入为空 ⇒ 没有可检查的对象'], phases: {} }

  /* ---- 正控：每个条目都必须形成一条"报警"读数，且提示里必须逐字带上回复 ---- */
  const positive = await runPass({
    items,
    judge: () => Promise.resolve(fakeCall(labelsOf('UNSUPPORTED_RECOLLECTION'))),
    minIntervalMs: 0,
  })
  const positiveBad = positive.observations.filter((entry) => !entry.ok || entry.alertState !== 'alert')
  if (positiveBad.length > 0) {
    failures.push(`正控：${String(positiveBad.length)} 条没读成 alert（${positiveBad.map((e) => e.turnId).join(',')}）`)
  }
  const promptMissing = items.filter((entry) => !entry.prompt.includes(entry.item.responseText))
  if (promptMissing.length > 0) {
    failures.push(`正控：${String(promptMissing.length)} 条的提示里**没有**逐字回复 ⇒ 组装的不是这份证据`)
  }
  const withoutActualContext = items.filter((entry) => !entry.facts.actualContextAvailable)
  const actualContextNotDeclared = withoutActualContext.filter(
    (entry) => entry.facts.actualContextUnavailableReason === undefined
  )
  if (actualContextNotDeclared.length > 0) {
    failures.push(
      `正控：${String(actualContextNotDeclared.length)} 条的 actualContext 不可用却**没给具名原因**（契约 §3 的机器判据）`
    )
  }

  /* ---- 负控①：空断言集 ⇒ 必须"不可判"，**不得**落成 no_alert ---- */
  const empty = await runPass({
    items,
    judge: () => Promise.resolve(fakeCall({ ok: true, output: { assertions: [] } })),
    minIntervalMs: 0,
  })
  const wronglySafe = empty.observations.filter((entry) => entry.alertState === 'no_alert' || entry.ok)
  if (wronglySafe.length > 0) {
    failures.push(
      `负控①：${String(wronglySafe.length)} 条在"空断言"下被读成**有结论**（${wronglySafe
        .map((e) => `${e.turnId}:${e.alertState}`)
        .join(',')}）⇒ 这正是"没读到当成没违规"`
    )
  }
  const causeUnset = empty.observations.filter((entry) => entry.undecidableCause !== 'empty_assertions')
  if (causeUnset.length > 0) {
    failures.push(`负控①：${String(causeUnset.length)} 条的不可判原因不是 empty_assertions ⇒ 细分原因丢了`)
  }

  /* ---- 负控②：一次传输失败 ⇒ 必须具名落成失败，**不得**落成 no_alert ---- */
  let flip = 0
  const transport = await runPass({
    items,
    judge: () => {
      flip += 1
      if (flip % 2 === 1) {
        return Promise.resolve({
          ...fakeCall({ ok: false, failure: 'empty', detail: '注入：传输失败' }),
          ok: false,
          parsed: null,
          callFailure: 'timeout',
          rawLength: 0,
        })
      }
      return Promise.resolve(fakeCall(labelsOf('SUPPORTED_RECALL')))
    },
    minIntervalMs: 0,
  })
  const transportNotNamed = transport.observations.filter(
    (entry) => entry.ok || entry.failure !== 'timeout' || entry.alertState !== 'undecidable'
  )
  if (transportNotNamed.length > 0) {
    failures.push(
      `负控②：${String(transportNotNamed.length)} 条在注入传输失败后没有落成具名失败` +
        `（${transportNotNamed.map((e) => `${e.turnId}:${String(e.failure)}/${e.alertState}`).join(',')}）`
    )
  }

  /* ---- 恢复：放回正常输入 ⇒ 回到正控的读数 ---- */
  const recovery = await runPass({
    items,
    judge: () => Promise.resolve(fakeCall(labelsOf('UNSUPPORTED_RECOLLECTION'))),
    minIntervalMs: 0,
  })
  const recoveryBad = recovery.observations.filter(
    (entry, index) => entry.alertState !== positive.observations[index]?.alertState
  )
  if (recoveryBad.length > 0) {
    failures.push(`恢复：${String(recoveryBad.length)} 条的读数与正控不一致 ⇒ 前面那两段不是"被注入的状态"`)
  }

  return {
    ok: failures.length === 0,
    failures,
    phases: {
      note: '三段式：合法输入必须给读数 · 空断言/传输失败必须记成不可判或具名失败 · 放回正常输入必须回到原读数',
      positive: {
        items: positive.observations.length,
        alert: positive.observations.filter((entry) => entry.alertState === 'alert').length,
        calls: positive.calls,
      },
      negativeEmptyAssertions: {
        undecidable: empty.observations.filter((entry) => entry.alertState === 'undecidable').length,
        wronglyDecided: wronglySafe.length,
      },
      negativeTransportFailure: {
        named: transport.observations.filter((entry) => entry.failure === 'timeout').length,
        wronglySafe: transportNotNamed.length,
      },
      recovery: {
        alert: recovery.observations.filter((entry) => entry.alertState === 'alert').length,
        mismatched: recoveryBad.length,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  assertTestWrapper()
  if (SAMPLES_PER_ITEM !== 2) {
    throw new Error(`CD-10 的读数定义要求每条判两次；当前 SAMPLES_PER_ITEM=${String(SAMPLES_PER_ITEM)}`)
  }
  const runIds = argsOf('--run')
  if (runIds.length === 0) throw new Error('必须给 --run <基线 runId>（可重复）')
  const dryRun = hasFlag('--dry-run')

  /* ---- 守卫：判定提示必须与冻结量具**逐字同一** ---- */
  const probePath = join(ROOT, 'evals', 'm6.1', 'probes', 'stability-probe.jsonl')
  if (!existsSync(probePath)) throw new Error(`缺探针集 ${probePath} ⇒ 无法证明"同一件量具"`)
  const probeItems = itemsFromCorpus(readJsonLines(probePath))
  if (probeItems.length === 0) throw new Error('探针集 0 项 ⇒ MEASUREMENT INVALID')
  const promptDigest = probePromptDigest(probeItems)
  if (promptDigest !== FROZEN_PROBE_PROMPT_DIGEST) {
    throw new Error(
      `失败关闭：判定提示摘要 ${promptDigest.slice(0, 12)}… ≠ 冻结值 ${FROZEN_PROBE_PROMPT_DIGEST.slice(0, 12)}…\n` +
        `提示版本常量是 ${M6_1_JUDGE_PROMPT_VERSION}。提示正文（或探针集）变了 ⇒ ` +
        '"用契约 @4 的有效量具跑基线"这句话不再成立，**拒绝**出读数。'
    )
  }

  const realDbBefore = digestTree(PRODUCTION_DB_DIR)

  const perRun: {
    readonly runId: string
    readonly arm: string
    readonly rollupTokens: number | null
    readonly diagnostic: boolean
    readonly traceTurnCount: number
    readonly items: readonly AssembledItem[]
    readonly mappingNote: string
  }[] = []

  for (const runId of runIds) {
    const runDir = join(ROOT, 'artifacts', 'm6.1', runId)
    const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
    const baselinePath = join(runDir, 'baseline.json')
    const turnsPath = join(localDir, 'turns.jsonl')
    const tracePath = join(localDir, 'trace-readout.json')
    for (const path of [baselinePath, turnsPath, tracePath]) {
      if (!existsSync(path)) {
        throw new Error(
          `MEASUREMENT INVALID：缺 ${relative(ROOT, path)} ⇒ ` +
            (path === tracePath
              ? '先用 `pnpm exec tsx scripts/m6.1-wp3-trace.ts --run ' + runId + '` 取"她实际看到了什么"'
              : '基线不完整，不许判')
        )
      }
    }
    const reading = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineReading
    const turns = readJsonLines(turnsPath) as BaselineTurnRow[]
    const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceReadoutFile
    if (turns.length === 0) throw new Error(`MEASUREMENT INVALID：${runId} 的 turns.jsonl 有 0 条`)

    /* ---- ③ 判定的字节必须是被记录的字节 ---- */
    const mismatches: string[] = []
    for (const [index, turn] of turns.entries()) {
      const recorded = reading.turns[index]
      if (recorded === undefined || recorded.id !== turn.id) {
        mismatches.push(`${turn.id}: 与 baseline.json 的第 ${String(index + 1)} 轮对不上`)
        continue
      }
      if (sha256OfText(turn.reply) !== recorded.replySha256) mismatches.push(`${turn.id}: 回复哈希不符`)
      if (sha256OfText(turn.userText) !== recorded.userTextSha256) mismatches.push(`${turn.id}: 用户原话哈希不符`)
    }
    if (mismatches.length > 0) {
      throw new Error(
        `MEASUREMENT INVALID：${runId} 的本地正文与落盘哈希不符（${mismatches.slice(0, 5).join('；')}）` +
          ' ⇒ 我判的不是当时那一句，拒绝出读数'
      )
    }

    const { items, problems } = assembleItems({ runId, reading, turns, trace })
    if (problems.length > 0) {
      throw new Error(`MEASUREMENT INVALID：${runId} 组装失败 —— ${problems.join('；')}`)
    }
    perRun.push({
      runId,
      arm: String(reading.arm),
      rollupTokens: reading.rollupTokens ?? null,
      diagnostic: reading.diagnostic === true,
      traceTurnCount: trace.turns?.length ?? 0,
      items,
      mappingNote:
        '第 ③ 套事实按 trace `startedAt` 升序 ↔ 场景执行顺序配对。依据：基线脚本**顺序**执行每一轮，' +
        '且每条 trace 恰有一次 `conversation_persist_input` / `model_generate`；' +
        '两者轮数不等时上面已拒绝组装。',
    })
    console.log(
      `  ${runId}\n    arm=${String(reading.arm)} rollupTokens=${String(reading.rollupTokens)} ` +
        `轮数=${String(items.length)}（trace ${String(trace.turns?.length ?? 0)}）`
    )
  }

  const allItems = perRun.flatMap((entry) => entry.items)
  console.log('')
  console.log('='.repeat(78))
  console.log('M6.1 WP3 判定读数（**冻结量具**；只出读数，不出度量）')
  console.log('='.repeat(78))
  console.log(`  条目        ${String(allItems.length)} 条（${String(perRun.length)} 个基线轮）`)
  console.log(`  判定提示    ${M6_1_JUDGE_PROMPT_VERSION} · 探针摘要 ${promptDigest.slice(0, 12)}…（= 冻结值）`)
  console.log(`  采样        ${String(SAMPLES_PER_ITEM)} 次/条 ⇒ 最少 ${String(allItems.length * SAMPLES_PER_ITEM)} 次调用`)

  /* ---- 三段式自证：不过就不许跑 live ---- */
  const selfTestResult = await selfTest(allItems)
  console.log(
    `  自证        ${selfTestResult.ok ? 'PASS（正控 / 两条负控 / 恢复）' : 'FAIL'}` +
      ` · 条目 ${String(allItems.length)} · 零模型调用`
  )
  if (!selfTestResult.ok) {
    for (const failure of selfTestResult.failures) console.log(`    ✗ ${failure}`)
    throw new Error('MEASUREMENT INVALID：本门的三段式自证没过 ⇒ 不许拿它的读数当证据')
  }
  const actualContextMissing = allItems.filter((entry) => !entry.facts.actualContextAvailable)
  console.log(
    `  第③套事实   可用 ${String(allItems.length - actualContextMissing.length)} 条，` +
      `不可用（具名原因）${String(actualContextMissing.length)} 条`
  )
  if (actualContextMissing.length > 0) {
    for (const entry of actualContextMissing) {
      console.log(`    · ${entry.turnId}: ${String(entry.facts.actualContextUnavailableReason)}`)
    }
  }

  if (dryRun) {
    console.log('')
    console.log('  --dry-run：只组装，不调用模型、不落证据。')
    for (const entry of allItems) {
      console.log(
        `    ${entry.turnId.padEnd(5)} 提示 ${String(entry.prompt.length).padStart(6)} 字 · ` +
          `回复 ${String(entry.responseChars).padStart(4)} 字 · sha ${entry.promptSha256.slice(0, 8)}`
      )
    }
    return
  }

  const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
  console.log(
    `  判定器      ${judge.id} · host=${judge.baseUrlHost} · model=${judge.model} · ` +
      `maxTokens=${String(judge.maxTokens)} · reasoning=${judge.reasoningEffort}`
  )
  console.log('')

  const results: {
    readonly runId: string
    readonly arm: string
    readonly pass: Awaited<ReturnType<typeof runPass>>
    readonly counts: {
      readonly items: number
      readonly decided: number
      readonly alert: number
      readonly noAlert: number
      readonly undecidable: number
      readonly calls: number
    }
  }[] = []
  for (const entry of perRun) {
    console.log(`  ── ${entry.runId}（${entry.arm}）`)
    const pass = await runPass({ items: entry.items, judge: (p) => judge.judge(p), minIntervalMs: M6_1_JUDGE_MIN_INTERVAL_MS })
    results.push({
      runId: entry.runId,
      arm: entry.arm,
      pass,
      counts: {
        items: pass.observations.length,
        decided: pass.observations.filter((o) => o.ok).length,
        alert: pass.observations.filter((o) => o.alertState === 'alert').length,
        noAlert: pass.observations.filter((o) => o.alertState === 'no_alert').length,
        undecidable: pass.observations.filter((o) => o.alertState === 'undecidable').length,
        calls: pass.calls,
      },
    })
    for (const observation of pass.observations) {
      const labels = observation.predictedLabels.length === 0 ? '（无细标签）' : observation.predictedLabels.join(', ')
      console.log(
        `    ${observation.turnId.padEnd(5)} ${observation.alertState.padEnd(13)} ` +
          `${observation.ok ? '读数成立' : `未成立(${String(observation.failure)})`}  ${labels}`
      )
    }
    console.log(
      `    小计：读数成立 ${String(pass.observations.filter((o) => o.ok).length)}/${String(
        pass.observations.length
      )} · 报警 ${String(pass.observations.filter((o) => o.alertState === 'alert').length)} · ` +
        `不报警 ${String(pass.observations.filter((o) => o.alertState === 'no_alert').length)} · ` +
        `不可判 ${String(pass.observations.filter((o) => o.alertState === 'undecidable').length)} · ` +
        `调用 ${String(pass.calls)}`
    )
  }
  /* ---- 计数型自检 ---- */
  const measured = results.reduce((sum, entry) => sum + entry.pass.observations.length, 0)
  if (measured === 0) {
    throw new Error('MEASUREMENT INVALID：形成 0 条读数 ⇒ "一条都没判"与"全都安全"在输出上长得一样')
  }

  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const realDbReadout = {
    note: '只做**文件树摘要**，不通过打开数据库计算；本门**从不**打开任何数据库',
    before: { files: realDbBefore.measuredCount, treeSha256: realDbBefore.treeSha256 },
    after: { files: realDbAfter.measuredCount, treeSha256: realDbAfter.treeSha256 },
    unchanged: realDbBefore.treeSha256 === realDbAfter.treeSha256,
  }

  const judgeRunId = createRunId({
    wpId: 'wp3-judge',
    headShort: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
  })
  const judgeRunDir = openRunDir(ROOT, judgeRunId)
  const judgeLocalDir = join(ROOT, M6_1_LOCAL_PARENT, judgeRunId)
  mkdirSync(judgeLocalDir, { recursive: true })

  const reading = {
    schemaVersion: 'm6.1-wp3-judge@1',
    judgeRunId,
    judgedRuns: perRun.map((entry) => ({
      runId: entry.runId,
      arm: entry.arm,
      rollupTokens: entry.rollupTokens,
      diagnostic: entry.diagnostic,
      traceTurnCount: entry.traceTurnCount,
      mappingNote: entry.mappingNote,
    })),
    judge: {
      id: judge.id,
      host: judge.baseUrlHost,
      model: judge.model,
      reasoningEffort: judge.reasoningEffort,
      maxTokens: judge.maxTokens,
      promptVersion: M6_1_JUDGE_PROMPT_VERSION,
      probePromptDigest: promptDigest,
      frozenProbePromptDigest: FROZEN_PROBE_PROMPT_DIGEST,
      promptDigestMatchesFrozen: promptDigest === FROZEN_PROBE_PROMPT_DIGEST,
      limitation:
        '判定器与**被测端**是否为同一模型未在本门核对；若相同则误差相关，**不能**称独立验证。',
    },
    sampling: { samplesPerItem: SAMPLES_PER_ITEM, minIntervalMs: M6_1_JUDGE_MIN_INTERVAL_MS },
    /** 本场景**没有**人工标注 ⇒ 没有度量。这一条是主张边界，不是备注。 */
    annotation: {
      kind: 'none',
      note:
        'WP3 场景是**根因探针**，不是标注语料：没有 `expectedLabels`，因此本门**不**算召回率 / ' +
        '误报率、**不**给出任何"合格 / 不合格"判定。机器门与产品阈值是计划书 §7 的**人工裁定项**。',
    },
    items: allItems.map((entry) => ({
      itemId: entry.itemId,
      turnId: entry.turnId,
      category: entry.category,
      promptSha256: entry.promptSha256,
      promptChars: entry.prompt.length,
      responseChars: entry.responseChars,
      facts: entry.facts,
    })),
    results: results.map((entry) => ({
      runId: entry.runId,
      arm: entry.arm,
      observations: entry.pass.observations.map((observation) => ({
        itemId: observation.itemId,
        turnId: observation.turnId,
        category: observation.category,
        ok: observation.ok,
        alertState: observation.alertState,
        predictedLabels: observation.predictedLabels,
        failure: observation.failure,
        undecidableCause: observation.undecidableCause,
        samples: observation.samples,
        callFailure: observation.callFailure,
      })),
      counts: entry.counts,
      callFailureTally: entry.pass.callFailureTally,
      durationMs: entry.pass.durationMs,
    })),
    selfTest: selfTestResult.phases,
    selfTestPassed: selfTestResult.ok,
    realDbProtection: realDbReadout,
    rawTextLocation: relative(ROOT, join(judgeLocalDir, 'judge-raw.jsonl')).split(/[\\/]/).join('/'),
    notClaimed: [
      '**不**主张根因（这是 WP3 的读数，不是裁定）',
      '**不**主张任何召回率 / 误报率 / 合格率 —— 本场景没有人工标注',
      '**不**主张第 ③ 套事实是"逐字上下文"（它是结构性重建）',
      '**不**主张本场景设计已经过人工审阅（它是提案）',
      '**不**主张机器门或产品阈值已定（那是人工裁定项）',
    ],
  }
  const readingText = `${JSON.stringify(reading, null, 2)}\n`
  writeFileSync(join(judgeRunDir, 'wp3-judge.json'), readingText, 'utf8')

  const rawLines: string[] = []
  for (const entry of results) {
    for (const observation of entry.pass.observations) {
      rawLines.push(
        JSON.stringify({
          runId: entry.runId,
          arm: entry.arm,
          itemId: observation.itemId,
          turnId: observation.turnId,
          alertState: observation.alertState,
          ok: observation.ok,
          samples: observation.samples,
          sampleRecords: observation.sampleRecords,
        })
      )
    }
  }
  writeFileSync(join(judgeLocalDir, 'judge-raw.jsonl'), `${rawLines.join('\n')}\n`, 'utf8')

  const manifestPath = writeManifestAtomic(judgeRunDir, {
    schemaVersion: 'm6.1-manifest@1',
    runId: judgeRunId,
    testType:
      'M6.1 WP3 判定读数（冻结量具 `m6.1-judge-prompt@4` 判 WP3 基线回复；**不打开任何数据库**、**不算度量**）',
    phases: ['wp3-judge'],
    counts: {
      executed: 1,
      completed: 1,
      skipped: 0,
      failed: results.reduce((sum, entry) => sum + entry.counts.undecidable, 0),
    },
    evidence: [
      {
        path: relative(ROOT, join(judgeRunDir, 'wp3-judge.json')).split(/[\\/]/).join('/'),
        sha256: sha256OfText(readingText),
      },
    ],
    realDbProtection: realDbReadout,
    notClaimed: reading.notClaimed,
    /*
     * L-M61-14（2026-09-26 技术债清偿）：此前只写了子集 ⇒ `m6.1:gates` 读不进来。
     * 公共字段改由唯一实现装配（与 `m6.1-live-short` / `m6.1-baseline` 同一份）。
     */
    ...standardManifestFields({
      startedAt: STARTED_AT,
      commands: [{ cmd: INVOKED_COMMAND, exitCode: null }],
      corpusVersionDefinition:
        '本门只**判**一份既有基线读数（WP3），不读语料目录；' +
        '`corpusVersion` 记的是冻结语料版本号，被判的条目见 `wp3-judge.json`。',
      exclusions: ['artifacts/m6.1/local/'],
    }),
  })

  console.log('')
  console.log(`  证据   ${relative(ROOT, join(judgeRunDir, 'wp3-judge.json')).split(/[\\/]/).join('/')}`)
  console.log(`  清单   ${relative(ROOT, manifestPath).split(/[\\/]/).join('/')}`)
  console.log(`  正文   ${reading.rawTextLocation}（gitignored）`)
  console.log(`  真实库 ${realDbReadout.unchanged ? '**未被改动**' : '**摘要不同 ⇒ 无法归属，必须人工看**'}`)
}

await main()
