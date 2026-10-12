/**
 * M6.1 WP2 —— **量具的真实读数**（`pnpm with-test-model pnpm m6.1:instrument:live`）。
 *
 * ============================================================================
 *  这份脚本要回答的问题
 * ============================================================================
 *  「把**真实模型**接到同一个纯核心上，按 CD-7 冻结的量具有效性标准，
 *    这个量具**能不能用**。」
 *
 *  三条入口纪律（写死在代码里，不靠自觉）：
 * ```text
 *   ① 必须经测试包装器（缺 DSH_TEST_MODEL_WRAPPER ⇒ 拒绝，绝不回落 .env 的原 Key）
 *   ② 必须有 API key（缺 ⇒ 拒绝，不假装跑过）
 *   ③ 调用失败 / 解析失败 / 弃判**都进分母**，绝不剔除（计划书 §6.3）
 * ```
 *
 * ============================================================================
 *  它**不**主张什么（这一段和读数一样重要）
 * ============================================================================
 * ```text
 *   · 这是"量具有效性"的读数，**不是产品门**。产品门阈值属于 WP3。
 *   · 判定器与**被测端**是否为同一模型未在本门核对；若相同则误差相关 ⇒ **不能**称独立验证。
 *   · INVALID / INCONCLUSIVE 也是**合格的结果**：计划书 §WP2 的出口写着"否则停在量具阶段，
 *     不以调低产品门换取通过"。本脚本**不**提供任何"重跑到绿"的开关。
 * ```
 *
 * 本门**不**打开真实库、**不**改生产配置、**不**接生产回复链。
 *
 * 用法：
 *   pnpm with-test-model pnpm m6.1:instrument:live
 *   pnpm with-test-model pnpm m6.1:instrument:live -- --limit 8   # 预检（不作有效性判定）
 *   # 官方 key 高并发档（用户 2026-09-25：官方并发上限 2500，TPM 限流是测试 key 特有）：
 *   #   只改吞吐不进 resumeKey/configKey；缺省 1 = 原串行行为
 *   $env:OPENAI_API_KEY='…'; $env:OPENAI_BASE_URL='https://api.deepseek.com'; …
 *   pnpm m6.1:instrument:live -- --corpus acceptance --concurrency 16
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
  alertStateOf,
} from './m6.1-contract.ts'
import {
  ACCEPTANCE_MANIFEST_PATH,
  CORPUS_FILES,
  M6_1_ACCEPTANCE_VERSION,
  assertAcceptanceApproved,
  assertCorpusRunMode,
  corpusIdentity,
  parseCorpusName,
  type CorpusName,
} from './m6.1-acceptance-corpus.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import {
  PROBE_SET_VERSION,
  aggregateCrossRun,
  crossRunConfigKey,
  probePromptDigest,
} from './m6.1-cross-run-core.ts'
import {
  RunDirExistsError,
  assertValidRunId,
  createRunId,
  openRunDir,
  sha256OfText,
  writeManifestAtomic,
} from './m6.1-evidence.ts'
import {
  INSTRUMENT_VALIDITY_CRITERIA,
  M6_1_JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  computeMetrics,
  computeStability,
  evaluateValidity,
  itemsFromCorpus,
  judgeItem,
  judgmentFromSamples,
  computeCrossRunStability,
  selectItemsById,
  summarizeCounting,
  type CrossRunSample,
  type InstrumentItem,
  type ItemJudgment,
  type StabilityInput,
  type StabilitySample,
  type ValidityDecision,
} from './m6.1-instrument.ts'
import {
  M6_1_INSTRUMENT_JUDGE_ID,
  M6_1_JUDGE_MAX_ATTEMPTS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  createOpenAiInstrumentJudge,
} from './m6.1-judge-openai.ts'

const ROOT = resolve(process.cwd())
const SPLITS = ['dev', 'calibration', 'heldout'] as const

/** CD-10：一条读数 = 同一输入判**两次**且标签集合完全相同 */
const READINGS_PER_ITEM = 2

interface CliOptions {
  /** 语料选择（工作单第 3 项：新 heldout 必须单独出分母） */
  readonly corpus: CorpusName
  readonly limit: number | null
  /**
   * `--only <id,id,…>`：**诊断档**，只跑指定的语料条目。
   *
   * ⚠️ 它和 `--limit` 是同一类东西：**改动分母** ⇒ 本读数一律判 `INCONCLUSIVE`，
   *    绝不允许 "只跑有利的几条 ⇒ 拿一个好看的 VALID"。
   *    与 `--limit` 的区别只是"取哪几条"：`--limit` 取前 N 条，`--only` 按 id 点名。
   *    证据里会逐字记下**实际跑了哪些 id**，否则事后无法判断分母是怎么来的。
   */
  readonly only: readonly string[] | null
  /** `--resume <runId>`：从断点接着跑（目录必须存在且**没有** manifest.json） */
  readonly resume: string | null
  /**
   * `--concurrency N`：**同时判定的条目数**（缺省 1 = 逐条串行，现行为）。
   *
   * ⚠️ 它**只改吞吐，不改任何判定**（与 live-short 的 `--turn-interval-ms` 同一纪律）：
   *    不进判据、不进 `resumeKey` / CD-9 的 `configKey`、不进候选冻结件 ⇒
   *    用它**不需要**重取候选，跨并发值的续跑也合法（同一次测量，不同节奏）。
   *    每个条目自己的两次采样之间仍保留 `M6_1_JUDGE_MIN_INTERVAL_MS` 间隔
   *    （N=1 时节奏与串行版逐字节一致：除全轮第一次调用外，每次调用前都有间隔）。
   *
   * 为什么需要（用户 2026-09-25 裁定）：官方 key 的并发上限很高（用户实测口径 **2500**），
   * 而 TPM 限流是**测试 key** 特有的 ⇒ 用官方 key 跑量具时可以放心并发。
   * 缺省仍是 1：测试 key 的轮次不因此改变行为。
   * 可用上限 = 本轮条目数（62）；给再大只是空转 worker，因此 CLI 上限取 128 足够。
   */
  readonly concurrency: number
}

function parseArgs(argv: readonly string[]): CliOptions {
  let corpus: CorpusName = 'legacy'
  let limit: number | null = null
  let only: string[] | null = null
  let resume: string | null = null
  let concurrency = 1
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--corpus') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--corpus 后面必须是 legacy 或 acceptance')
      }
      corpus = parseCorpusName(value)
      index += 1
      continue
    }
    if (argv[index] === '--limit') {
      const value = Number(argv[index + 1] ?? '')
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit 必须是正整数（收到 ${String(argv[index + 1])}）`)
      }
      limit = value
      index += 1
      continue
    }
    if (argv[index] === '--only') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--only 后面必须是逗号分隔的条目 id（例：--only H-1,H-3,B-6）')
      }
      const ids = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      if (ids.length === 0) throw new Error('--only 解析出 0 个 id ⇒ 拒绝运行')
      only = ids
      index += 1
      continue
    }
    if (argv[index] === '--resume') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--resume 后面必须是一个 runId')
      }
      resume = value
      index += 1
      continue
    }
    if (argv[index] === '--concurrency') {
      const value = Number(argv[index + 1] ?? '')
      if (!Number.isInteger(value) || value < 1 || value > 128) {
        throw new Error(
          `--concurrency 必须是 1..128 的整数（收到 ${String(argv[index + 1])}；` +
            '可用上限=本轮条目数，给再大只是空转 worker）'
        )
      }
      concurrency = value
      index += 1
      continue
    }
    /*
     * ⚠️ **未知参数一律拒绝**（本轮实测逼出来的）。
     *
     * 实测：`--only J-4,J-2,H-1` 在 PowerShell 里被当成**三个**参数
     * （逗号在 PS 里是数组分隔符），而第一版 `parseArgs` 只吃 `--only` 后面的**一个**值、
     * 把剩下的当空气 ⇒ 静默只跑了 1 条 J-4，控制台还一本正经地出"真实读数"。
     * 证据里 `scope.requestedOnly` 如实记着 `['J-4']`（所以没有谎报），
     * 但**命令行与意图不一致却没有任何提示**，这种"静默少跑"必须失败关闭。
     */
    if (argv[index].startsWith('--')) {
      throw new Error(
        `未知参数 ${argv[index]}（本门只认 --limit / --only / --resume / --concurrency；` +
          '如果 --only 的值里有逗号，请用引号包住整串，例如 --only "J-4,J-2,H-1"）'
      )
    }
    throw new Error(
      `多余的参数 ${argv[index]}（没有归属的裸参数会被静默忽略 ⇒ 拒绝运行；` +
        '要把 id 列表传给 --only，请加引号）'
    )
  }
  /*
   * `--limit` 与 `--only` 同时给会让"分母是怎么来的"变得说不清
   * （先截断再点名？先点名再截断？两种都有人猜）⇒ **失败关闭**，让人只选一个。
   */
  if (limit !== null && only !== null) {
    throw new Error('--limit 与 --only 不能同时使用（两者都在改分母，叠加会让分母无法复述）')
  }
  assertCorpusRunMode(corpus, { limit, only })
  return { corpus, limit, only, resume, concurrency }
}

function headOf(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

/**
 * 读语料。
 *
 * ⚠️ 工作单第 3 项：新 heldout（`acceptance`）必须**单独**出分母 ——
 * 所以这里按 `CORPUS_FILES` 两套**互不相交**的清单读，绝不"顺手多读一个目录"。
 * 读验收语料时额外做两道**绑定检查**：
 * ```text
 *   ① sha256(acceptance-v1.jsonl) 必须等于它自己 manifest 里记的摘要
 *      ⇒ "这次跑的就是审核过的那一版语料"，语料被改过就失败关闭
 *   ② declared 条数必须 ≥ minItems（冻结标准里的总数下限）
 *      ⇒ 分母不够时**当场**失败，而不是跑完之后才发现判据不适用
 * ```
 */
function readFrozenCorpus(corpus: CorpusName, limit: number | null): InstrumentItem[] {
  const files = CORPUS_FILES[corpus]
  if (files.length === 0) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：语料 ${corpus} 的文件清单为空`)
  }
  const items: InstrumentItem[] = []
  for (const rel of files) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺语料 ${rel}`)
    }
    const text = readFileSync(abs, 'utf8')
    if (corpus === 'acceptance') {
      const manifestPath = join(ROOT, ACCEPTANCE_MANIFEST_PATH)
      if (!existsSync(manifestPath)) {
        throw new MeasurementInvalidError(
          `MEASUREMENT INVALID：验收语料缺清单 ${ACCEPTANCE_MANIFEST_PATH} ⇒ 无法绑定版本`
        )
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        digests?: { jsonl?: string }
        reviewStatus?: string
      }
      /*
       * ⚠️ **人工审核签字才许跑**（工作单第 2 项）。这是闸，不是纪律：
       * 未签字时直接拒绝运行，谁都跑不出"试判"这一步。
       */
      try {
        assertAcceptanceApproved(manifest.reviewStatus ?? '(缺失)')
      } catch (error) {
        throw new MeasurementInvalidError(
          `拒绝运行：${error instanceof Error ? error.message : String(error)}`
        )
      }
      const recorded = manifest.digests?.jsonl
      if (recorded === undefined) {
        throw new MeasurementInvalidError('MEASUREMENT INVALID：验收语料清单里没有 jsonl 摘要')
      }
      if (sha256OfText(text) !== recorded) {
        throw new MeasurementInvalidError(
          'MEASUREMENT INVALID：验收语料正文与清单里记的摘要**不一致** ⇒ ' +
            '这次跑的不是审核过的那一版，拒绝运行'
        )
      }
    }
    const rows: unknown[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line))
    }
    items.push(...itemsFromCorpus(rows))
  }
  if (items.length === 0) throw new MeasurementInvalidError('MEASUREMENT INVALID：语料 0 条')
  if (corpus === 'acceptance' && items.length < INSTRUMENT_VALIDITY_CRITERIA.minItems) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：验收语料只有 ${String(items.length)} 条 < 冻结标准的总数下限 ` +
        `${String(INSTRUMENT_VALIDITY_CRITERIA.minItems)} ⇒ 分母不足以支撑判定`
    )
  }
  return limit === null ? items : items.slice(0, limit)
}

/**
 * `--only <ids>` 的选取：**按点名顺序**返回，且缺一个 id 就失败关闭。
 *
 * 纯逻辑在 `selectItemsById()`（可被部件级测试钉住）；这里只负责把"缺 id"变成
 * 失败关闭 —— 静默忽略会让"我点了 5 条、实际跑了 3 条"变成一份看不出来的读数。
 */
function selectOnly(items: readonly InstrumentItem[], ids: readonly string[]): InstrumentItem[] {
  const { selected, missing } = selectItemsById(items, ids)
  if (missing.length > 0) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：--only 里有 ${String(missing.length)} 个 id 不在冻结语料里（${missing.join(', ')}）`
    )
  }
  return selected
}

/** CD-8 探针集：**跨轮稳定性**的分母。缺文件 ⇒ 直接失败关闭（"没测到"≠"通过"）。 */
function readStabilityProbe(): InstrumentItem[] {
  const abs = join(ROOT, 'evals', 'm6.1', 'probes', 'stability-probe.jsonl')
  if (!existsSync(abs)) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：CD-8 探针集不存在 ${abs} ⇒ 稳定性没测到，不能算通过`
    )
  }
  const rows: unknown[] = []
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    rows.push(JSON.parse(line))
  }
  const items = itemsFromCorpus(rows)
  if (items.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：CD-8 探针集 0 项')
  }
  return items
}

/** 只保存**计数与引用**：不放语料正文、不放模型输出（那两样留本地）。 */
interface ObservationRecord {
  readonly itemId: string
  readonly category: string
  readonly ok: boolean
  readonly callFailure: string | null
  readonly parseFailure: string | null
  readonly finishReason: string | null
  readonly predictedLabels: readonly string[]
  readonly expectedLabels: readonly string[]
  /**
   * `CD-14` 的三态（验收口径）。旧证据里没有这个字段 ⇒ 读取时按 `predictedAlert` 与
   * `readings` 复算，**不**假定它等于"有报警标签"。
   */
  readonly alertState?: string
  readonly predictedAlert: boolean
  readonly expectedAlert: boolean
  readonly httpStatus: number | null
  readonly rawLength: number
  /** 这次判定一共尝试了几次（传输层重试可见；"重试到成功"与"只留最好一次"的区别在这里） */
  readonly attempts: number
  /**
   * 两次采样的标签集合（CD-13 之后口径变了，见下）。
   *
   * ⚠️ 在 `CD-14` 之后，**标签集合为空的那次采样**（判定器没给结论）也照实记成 `[]` ——
   * 它和"传输失败没拿到采样"是两回事：后者不进这个数组，由 `callFailure` 表达。
   */
  readonly readings?: readonly (readonly string[])[]
  readonly durationMs: number
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const options = parseArgs(process.argv.slice(2))

/*
 * `commands[0].cmd` 必须记**实际这一次**是怎么跑的。
 *
 * ⚠️ 实测缺陷（2026-09-23）：这一格此前写死成 `pnpm with-test-model pnpm m6.1:instrument:live` ——
 * 而本门的语料**缺省是 legacy**，所以照它复现会跑在**另一套语料**上，得到的自然不是同一份读数。
 * 那正是"字段存在、但它描述的不是你以为的那个东西"：`scope.corpus` 记了真值，
 * `commands` 却给出一条**跑不出这份读数**的命令。
 *
 * 现在由**真实解析结果**拼出来，且显式写出 `--corpus`（哪怕它等于缺省值）——
 * 复现命令不许依赖"读的人记得缺省是什么"。
 */
const invokedCommand = [
  'pnpm with-test-model pnpm m6.1:instrument:live',
  `--corpus ${String(options.corpus)}`,
  ...(options.limit === null ? [] : [`--limit ${String(options.limit)}`]),
  ...(options.only === null ? [] : [`--only ${options.only.join(',')}`]),
  ...(options.resume === null ? [] : [`--resume ${options.resume}`]),
].join(' ')

  // 入口纪律 ①
  if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
    console.error(
      `[m6.1-instrument-live] wrapper_required：必须经测试包装器运行` +
        `（pnpm with-test-model pnpm m6.1:instrument:live）：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记` +
        ' ⇒ 拒绝，**绝不**回落到 .env 的原 Key'
    )
    process.exit(2)
  }

  const items =
    options.only === null
      ? readFrozenCorpus(options.corpus, options.limit)
      : selectOnly(readFrozenCorpus(options.corpus, null), options.only)
  const probeItems = readStabilityProbe()
  const head = headOf()

  // 入口纪律 ②
  const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
  if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
    console.error('[m6.1-instrument-live] no_api_key：测试端点没有 key ⇒ 拒绝运行，不假装跑过')
    process.exit(2)
  }

  /*
   * ---- resumeKey：把"这一轮读数是在什么配置下跑出来的"钉住 ----
   *
   * 续跑的全部风险在于**把不同配置的片段拼成一份读数**（换了语料、换了标准、
   * 换了判定器、改了提示，都可能让前后两半不属于同一次测量）。
   * 因此把输入集合与配置摘要成一个键，续跑前必须比对一致。
   */
  /*
   * 提示**正文**的摘要：CD-9 的**可比性指纹**。
   *
   * ⚠️ 它**只**由探针集决定（`probePromptDigest` 的签名里根本没有语料条目，见该函数注释）。
   * 第一版折的是本轮全部条目 ⇒ 指纹随作用域变化，`--only` / `--limit` 的探针证据
   * 永远与全量轮不可比，跨轮历史永远凑不够 —— 那是**自己把自己排除掉**。
   */
  const promptDigest = probePromptDigest(probeItems)

  const resumeKey = sha256OfText(
    JSON.stringify({
      promptVersion: M6_1_JUDGE_PROMPT_VERSION,
      // ⚠️ 正文摘要也要进键：只写版本号时，"改了正文忘了升号"会静默通过续跑检查
      promptDigest,
      corpusItemIds: items.map((item) => item.itemId),
      probeItemIds: probeItems.map((item) => item.itemId),
      criteria: INSTRUMENT_VALIDITY_CRITERIA,
      judge: { id: judge.id, host: judge.baseUrlHost, model: judge.model },
    })
  )
  const resumeKeyPath = (dir: string): string => join(dir, 'resume-key.json')

  let runId: string
  let runDir: string
  if (options.resume !== null) {
    // ---- 续跑：复用既有目录，但**绝不允许**覆盖一份已完成的读数 ----
    runId = options.resume
    assertValidRunId(runId)
    runDir = join(ROOT, 'artifacts', 'm6.1', runId)
    if (!existsSync(runDir)) {
      console.error(`[m6.1-instrument-live] 失败关闭：--resume 的目录不存在 ${runDir}`)
      process.exit(2)
    }
    if (existsSync(join(runDir, 'manifest.json'))) {
      console.error(
        `[m6.1-instrument-live] 失败关闭：${runId} 已经有 manifest.json（一份**已完成**的读数）` +
          ' ⇒ 拒绝续跑覆盖它。旧读数不许被改写。'
      )
      process.exit(2)
    }
    const keyPath = resumeKeyPath(runDir)
    if (existsSync(keyPath)) {
      const previous = JSON.parse(readFileSync(keyPath, 'utf8')) as { resumeKey?: string }
      if (previous.resumeKey !== resumeKey) {
        console.error(
          `[m6.1-instrument-live] 失败关闭：resumeKey 不一致 —— ${runId} 是用**另一套配置**开的轮` +
            `（记录 ${String(previous.resumeKey).slice(0, 12)}… / 现在 ${resumeKey.slice(0, 12)}…）` +
            ' ⇒ 拒绝把不同配置的片段拼成一份读数'
        )
        process.exit(2)
      }
    } else {
      writeFileSync(keyPath, `${JSON.stringify({ resumeKey, promptVersion: M6_1_JUDGE_PROMPT_VERSION, promptDigest, note: '续跑配置指纹' }, null, 2)}\n`, 'utf8')
    }
    console.log(`[m6.1-instrument-live] **续跑** runId=${runId}`)
  } else {
    runId = createRunId({ wpId: 'wpinstr', headShort: head })
    try {
      runDir = openRunDir(ROOT, runId)
    } catch (error) {
      if (error instanceof RunDirExistsError) {
        console.error(`[m6.1-instrument-live] 失败关闭：${error.message}`)
        process.exit(2)
      }
      throw error
    }
    writeFileSync(resumeKeyPath(runDir), `${JSON.stringify({ resumeKey, promptVersion: M6_1_JUDGE_PROMPT_VERSION, promptDigest, note: '续跑配置指纹' }, null, 2)}\n`, 'utf8')
  }

  /*
   * ---- 断点：每判完一条就 append，长运行被杀不再整轮作废 ----
   *
   * ⚠️ `.partial` **不是读数**：只有 `manifest.json` 才能把一轮判成 COMPLETE。
   *    这份文件的作用是"少丢东西 + 能接着跑"。
   */
  const observationsPartialPath = join(runDir, 'observations.partial.jsonl')
  const stabilityPartialPath = join(runDir, 'stability.partial.jsonl')

  const doneObservations = new Map<string, ObservationRecord>()
  if (options.resume !== null && existsSync(observationsPartialPath)) {
    for (const line of readFileSync(observationsPartialPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const record = JSON.parse(line) as ObservationRecord
      doneObservations.set(record.itemId, record)
    }
    console.log(`  已从断点恢复 ${String(doneObservations.size)}/${String(items.length)} 条主循环观测`)
  }
  /** itemId → (sampleIndex → 采样) */
  const doneSamples = new Map<string, Map<number, StabilitySample>>()
  if (options.resume !== null && existsSync(stabilityPartialPath)) {
    for (const line of readFileSync(stabilityPartialPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const record = JSON.parse(line) as { itemId: string; sampleIndex: number } & StabilitySample
      const bucket = doneSamples.get(record.itemId) ?? new Map<number, StabilitySample>()
      bucket.set(record.sampleIndex, { ok: record.ok, labels: record.labels })
      doneSamples.set(record.itemId, bucket)
    }
    const total = [...doneSamples.values()].reduce((sum, bucket) => sum + bucket.size, 0)
    console.log(`  已从断点恢复 ${String(total)} 次探针采样`)
  }

  if (options.resume === null) {
    console.log(`[m6.1-instrument-live] runId=${runId}`)
    console.log(
      `  判定器    ${judge.id} · host=${judge.baseUrlHost} · model=${judge.model}`
    )
    console.log(
      `  标准      ${INSTRUMENT_VALIDITY_CRITERIA.status}（CD-7/CD-8）· 条目 ${String(items.length)}` +
        (options.limit === null ? '' : '（**--limit 预检，不构成有效性判定**）')
    )
    console.log(
      `  并发      ${String(options.concurrency)}（只改吞吐，不进 resumeKey/configKey；` +
        '每条仍为 2 次采样 + 采样间隔）'
    )
  }
  console.log(`  断点文件  ${observationsPartialPath.replace(ROOT, '').replace(/\\/g, '/')}`)

  const observations: ObservationRecord[] = []
  const judgments: ItemJudgment[] = []
  /*
   * ⚠️ **两份**失败计数，不许合成一份。
   *
   * 第一版只有一份 `failureTally`，主循环与 CD-8 探针循环都往里加。后果是
   * 实测 `…-e784` 那轮记着 `failureTally {truncated: 2}`，而主循环**一次失败都没有**
   * ——那 2 次全是探针 `probe-p4` 的采样失败（`stability.incomplete` 里写着）。
   * 报告里紧挨着「解析失败 / 弃判」打印，读起来就是"主循环有 2 次传输失败"。
   * 这正是"数字对、描述的不是你以为的那个东西"，因此按**来源**拆开。
   */
  const failureTally: Record<string, number> = {}
  const probeFailureTally: Record<string, number> = {}

  /*
   * ---- 主循环（`--concurrency` 起：有界 worker 池；缺省 1 = 原串行行为）----
   *
   * 纪律（用户 2026-09-25 裁定：官方 key 并发上限 2500，TPM 限流是**测试 key** 特有）：
   * · 并发**只改吞吐，不改任何判定**（与 live-short 的 `--turn-interval-ms` 同一纪律）：
   *   每条条目仍是"同一输入判两次（CD-10/CD-14）+ 采样间隔 + 同一判据"；
   *   不进 resumeKey / CD-9 configKey / 候选冻结件 ⇒ 跨并发值续跑合法（同一次测量，不同节奏）。
   * · **输出按语料序组装**（完成序只影响日志与 partial 行序）：
   *   observations / judgments 与串行版逐位相同 ⇒ 历史读数可比性不受影响。
   * · 节奏：每个 worker 自己记"是否已调用过"，调用前有间隔（除该 worker 的第一次）。
   *   N=1 时 = 原串行节奏（除全轮第一次调用外，每次调用前都有 1.5s 间隔）。
   */
  const pending = items.filter((item) => !doneObservations.has(item.itemId))
  const freshResults = new Map<string, { record: ObservationRecord; judgment: ItemJudgment }>()
  let cursor = 0
  let completed = 0
  const totalToJudge = pending.length
  const workerCount = Math.min(options.concurrency, Math.max(totalToJudge, 1))
  if (totalToJudge > 0) {
    console.log(
      `  判定阶段：${String(totalToJudge)} 条待判 · 并发 ${String(workerCount)}（每条仍为 ${String(READINGS_PER_ITEM)} 次采样 + 采样间隔）`
    )
  }
  const judgeOneItem = async (item: InstrumentItem, hasCalledBefore: () => boolean): Promise<void> => {
    const samples: string[][] = []
    let transportFailure: string | null = null
    /*
     * ⚠️ 每一次调用**真实**的传输读数都要留下来（不许用常量占位冒充测量值：
     * `counting.retriedItems` 按 `attempts > READINGS_PER_ITEM` 判定，常量会让它失真）。
     */
    let calls = 0
    let durationMsTotal = 0
    let lastHttpStatus: number | null = null
    let lastFinishReason: string | null = null
    let lastRawLength = 0
    for (let reading = 0; reading < READINGS_PER_ITEM; reading += 1) {
      if (hasCalledBefore()) {
        await new Promise<void>((resolve) => setTimeout(resolve, M6_1_JUDGE_MIN_INTERVAL_MS))
      }
      const attempt = await judge.judge(buildJudgePrompt(item))
      calls += attempt.attempts
      durationMsTotal += attempt.durationMs
      if (attempt.httpStatus !== null) lastHttpStatus = attempt.httpStatus
      if (attempt.finishReason !== null) lastFinishReason = attempt.finishReason
      if (attempt.rawLength > lastRawLength) lastRawLength = attempt.rawLength
      if (attempt.callFailure !== null) {
        failureTally[attempt.callFailure] = (failureTally[attempt.callFailure] ?? 0) + 1
        transportFailure = transportFailure ?? attempt.callFailure
        continue
      }
      const one = judgeItem(item, attempt.parsed ?? { ok: false, failure: 'empty', detail: '呼叫未成功' })
      if (one.alertState === 'undecidable') {
        /*
         * ⚠️ 采样**拿到了**但没给结论（空断言集 / 显式 INDETERMINATE）——
         * 这**不是**传输失败，只记"这条采样没给结论"，由 `judgmentFromSamples`
         * 按两次采样的组合去定读数。
         */
        samples.push([])
        continue
      }
      samples.push([...one.predictedLabels].sort())
    }

    const judgment = judgmentFromSamples(item, samples, transportFailure, READINGS_PER_ITEM)

    /*
     * 断点记录里**保留两次采样的标签集合** ⇒ 续跑时不用重调，且 UNRESOLVED 的判定
     * 可以被事后复核（"它当时见过哪两种"是证据，不该丢）。
     * `parseFailure` 装的是"为什么这条没形成有效读数"（解析失败或语义原因如
     * alert_state_disagreement）；名字不改（历史证据按此名读取）。
     */
    const record: ObservationRecord = {
      itemId: item.itemId,
      category: item.category,
      ok: judgment.ok,
      callFailure: transportFailure,
      parseFailure: judgment.ok ? null : (judgment.failure ?? null),
      finishReason: lastFinishReason,
      predictedLabels: judgment.predictedLabels,
      expectedLabels: judgment.expectedLabels,
      alertState: judgment.alertState,
      predictedAlert: judgment.predictedAlert,
      expectedAlert: judgment.expectedAlert,
      httpStatus: lastHttpStatus,
      rawLength: lastRawLength,
      // 真值：两次采样 + 各自内部的重试次数之和（不是常量 2）
      attempts: calls,
      durationMs: durationMsTotal,
      readings: samples,
    }
    freshResults.set(item.itemId, { record, judgment })
    // **断点**：完成一条立刻落盘（appendFileSync 同步写 ⇒ 并发下也不会交错断行）
    appendFileSync(observationsPartialPath, `${JSON.stringify(record)}\n`, 'utf8')
    completed += 1
    if (completed % 10 === 0 || completed === totalToJudge) {
      console.log(`  ... ${String(completed)}/${String(totalToJudge)} 已判定（断点已落盘）`)
    }
  }
  const worker = async (): Promise<void> => {
    let hasCalled = false
    const hasCalledBefore = (): boolean => {
      if (hasCalled) return true
      hasCalled = true
      return false
    }
    for (;;) {
      const slot = cursor
      cursor += 1
      if (slot >= pending.length) return
      await judgeOneItem(pending[slot]!, hasCalledBefore)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  /*
   * 按语料序组装（与串行版的输出逐位相同）：断点里已完成的条目直接沿用，
   * 新判的从 freshResults 取。computeMetrics 按 itemId 匹配（顺序无关），
   * 但证据文件里的 observations 顺序保持语料序 ⇒ 历史读数可比。
   */
  for (const item of items) {
    const done = doneObservations.get(item.itemId)
    if (done !== undefined) {
      observations.push(done)
      judgments.push(
        judgmentFromSamples(item, done.readings ?? [], done.callFailure, READINGS_PER_ITEM)
      )
      continue
    }
    const fresh = freshResults.get(item.itemId)
    if (fresh !== undefined) {
      observations.push(fresh.record)
      judgments.push(fresh.judgment)
    }
  }

  const metrics = computeMetrics(items, judgments)

  /*
   * ---- CD-8：跨轮稳定性探针 ----
   *
   * 同一批探针项，每项**连续问 k 次**，k 次必须给出同一标签集合。
   * 这是"可复现性"的直接机器判据 —— 轮内一致性拦不住"稳定地错"的判定器。
   */
  const k = INSTRUMENT_VALIDITY_CRITERIA.probeSamplesPerItem
  console.log(
    `\n[CD-8] 稳定性探针：${String(probeItems.length)} 项 × ${String(k)} 次 = ${String(probeItems.length * k)} 次调用`
  )
  const stabilityInputs: StabilityInput[] = []
  /*
   * 探针也走有界并发（同一 `--concurrency`）：**探针之间**并发，**单个探针内部的
   * k 次采样仍串行**（"连续问 k 次"的语义不变：每个探针自己的 k 次保持顺序与间隔）。
   * 完成序只影响日志行序；stabilityInputs 仍按探针集顺序组装 ⇒ 与串行版逐位相同。
   */
  const probeResults = new Map<string, StabilityInput & { failed: number; distinct: number; undecidableCount: number }>()
  let probeCursor = 0
  const probeWorkerCount = Math.min(options.concurrency, Math.max(probeItems.length, 1))
  const probeWorker = async (): Promise<void> => {
    for (;;) {
      const slot = probeCursor
      probeCursor += 1
      if (slot >= probeItems.length) return
      const probe = probeItems[slot]!
      const samples: StabilitySample[] = []
      const restored = doneSamples.get(probe.itemId)
      for (let sample = 0; sample < k; sample += 1) {
        const already = restored?.get(sample)
        if (already !== undefined) {
          samples.push(already)
          continue
        }
        await new Promise<void>((resolve) => setTimeout(resolve, M6_1_JUDGE_MIN_INTERVAL_MS))
        const result = await judge.judge(buildJudgePrompt(probe))
        const judgment = judgeItem(
          probe,
          result.parsed ?? { ok: false, failure: 'empty', detail: '呼叫未成功' }
        )
        /*
         * **带 ok**：没拿到结果的采样不能当成"另一种判定"，否则就把传输故障说成语义不一致。
         *
         * ⚠️ `CD-14` 之后 `ok` 的含义**变窄**：一次采样只要**拿到**了（哪怕它没给结论，
         * 即三态是"不可判定"）就 `ok = true` —— 它是一条**真实观察到的**采样。
         * "没给结论"由 `labels` 表达（空数组 = 空断言集）。
         * 只有**调用/解析失败**才 `ok = false`；那些采样**不进** CD-8 的分母，
         * 也不能被算成"不一致"。
         */
        const one: StabilitySample = {
          ok: result.callFailure === null,
          labels: [...judgment.predictedLabels],
        }
        samples.push(one)
        appendFileSync(
          stabilityPartialPath,
          `${JSON.stringify({ itemId: probe.itemId, sampleIndex: sample, ...one })}\n`,
          'utf8'
        )
        if (result.callFailure !== null) {
          probeFailureTally[result.callFailure] = (probeFailureTally[result.callFailure] ?? 0) + 1
        }
      }
      const failed = samples.filter((entry) => !entry.ok).length
      const states = samples
        .filter((entry) => entry.ok)
        .map((entry) => alertStateOf(entry.labels))
      const distinct = new Set(states)
      const undecidableCount = states.filter((state) => state === 'undecidable').length
      probeResults.set(probe.itemId, {
        itemId: probe.itemId,
        expectedAlert: probe.expectedAlert,
        samples,
        failed,
        distinct: distinct.size,
        undecidableCount,
      })
      console.log(
        failed > 0
          ? `  ⏸ ${probe.itemId} 采样失败 ${String(failed)}/${String(k)} ⇒ **没测到**（不是不一致）`
          : undecidableCount === states.length
            ? `  ⏸ ${probe.itemId} ${String(undecidableCount)}/${String(k)} 次都没给结论 ⇒ **没测到**（不算稳定）`
            : undecidableCount > 0
              ? `  ⏸ ${probe.itemId} 有 ${String(undecidableCount)}/${String(k)} 次没给结论 ⇒ **没测到**（不算稳定）`
              : `  ${distinct.size === 1 ? '✅' : '❌'} ${probe.itemId} 见过 ${String(distinct.size)} 种**报警性**`
      )
    }
  }
  await Promise.all(Array.from({ length: probeWorkerCount }, () => probeWorker()))
  for (const probe of probeItems) {
    const entry = probeResults.get(probe.itemId)
    if (entry !== undefined) {
      stabilityInputs.push({
        itemId: entry.itemId,
        expectedAlert: entry.expectedAlert,
        samples: entry.samples,
      })
    }
  }
  console.log('  探针完成')
  const stability = computeStability(stabilityInputs)

  /*
   * ==========================================================================
   *  CD-9 **接通**（用户 2026-09-23 工作单第 3 项）
   * ==========================================================================
   * 接通之前 live 门的 verdict 里一直写着 `cross_run_not_measured` ——
   * 量具在自己的读数里承认"跨轮可复现性没测到"，却仍然出 verdict（§13.3 登记的缺口）。
   *
   * 现在按工作单的要求做：**本轮采样完成后**，与**同配置历史**聚合，再生成最终 verdict。
   * ```text
   *   ① 本轮采样用**内存里刚跑完的**（不从磁盘读自己写了一半的断点）
   *   ② 历史从磁盘扫，且**排除本轮自己**
   *   ③ 只聚合同 configKey（提示正文摘要 + 探针集 + 判定器身份 + 推理档）
   *   ④ 历史不足 ⇒ evaluateCrossRun 判 INCONCLUSIVE（正确的失败关闭，不判通过）
   *   ⑤ 提示/模型/有效配置一变，配置键就变 ⇒ 旧读数**自动**不再参与比对
   * ```
   */
  const currentConfigKey = crossRunConfigKey(
    {
      id: judge.id,
      host: judge.baseUrlHost,
      model: judge.model,
      reasoningEffort: judge.reasoningEffort,
      promptVersion: M6_1_JUDGE_PROMPT_VERSION,
      promptDigest,
      maxTokens: judge.maxTokens,
      contractVersion: M6_1_CONTRACT_VERSION,
    },
    PROBE_SET_VERSION
  )
  if (currentConfigKey === null) {
    // 身份齐全却算出 null 只可能是代码改动引入的错，**失败关闭**而不是悄悄跳过 CD-9
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：本轮配置键算不出来（判定器身份缺失）⇒ CD-9 无法接通，拒绝出一份"看起来完整"的读数'
    )
  }
  const currentProbeSamples: CrossRunSample[] = stabilityInputs.flatMap((input) =>
    input.samples
      .filter((sample) => sample.ok)
      .map((sample) => ({
        runId,
        itemId: input.itemId,
        configKey: currentConfigKey,
        labels: [...sample.labels],
      }))
  )
  const crossAggregate = aggregateCrossRun({
    evalDir: join(ROOT, 'artifacts', 'm6.1'),
    currentRunId: runId,
    currentSamples: currentProbeSamples,
    configKey: currentConfigKey,
    computeStability: computeCrossRunStability,
  })
  const crossRun = crossAggregate.reading

  /*
   * `--limit` / `--only` 都是**诊断档**：它们改了分母，任何判定结论都会失真。
   * 直接标成 INCONCLUSIVE，而不是让它给出 VALID/INVALID —— 防"跑一半就去调阈值"，
   * 也防"只跑有利的那几条，拿一个好看的 VALID"。
   */
  const diagnosticReason =
    options.limit !== null
      ? `--limit ${String(options.limit)} 只跑了前若干条 ⇒ 分母被改动，本读数**不构成**量具有效性判定`
      : options.only !== null
        ? `--only 点名只跑了 ${String(items.length)} 条（${items.map((item) => item.itemId).join(', ')}）` +
          ' ⇒ 分母被改动，本读数**不构成**量具有效性判定'
        : null

  const decision: ValidityDecision =
    diagnosticReason === null
      ? evaluateValidity(metrics, INSTRUMENT_VALIDITY_CRITERIA, {
          criteriaFrozen: true,
          stability,
          crossRun,
        })
      : {
          verdict: 'INCONCLUSIVE',
          criteriaStatus: INSTRUMENT_VALIDITY_CRITERIA.status,
          reasons: [{ code: 'limited_run', detail: diagnosticReason }],
        }

  /*
   * 诊断档下**另算一份**"假如跑满会得到什么"，并把 CD-9 的读数喂进去。
   *
   * 为什么不是多余的：这样 `--only` 这类小实验也能**真正走一遍** CD-9 接线的后半段
   * （聚合 → evaluateValidity → 出理由码），而不必再开一轮全量去验证接线。
   * ⚠️ 它**不是** verdict：`verdict` 字段仍然是 INCONCLUSIVE，两份分开记录，
   *    任何人都不该拿 `recomputedFullDecision` 当读数用。
   */
  const recomputedFullDecision =
    diagnosticReason === null
      ? null
      : evaluateValidity(metrics, INSTRUMENT_VALIDITY_CRITERIA, {
          criteriaFrozen: true,
          stability,
          crossRun,
        })

  const observationText = `${JSON.stringify(
    {
      schemaVersion: 'm6.1-instrument-live@1',
      testId: 'M6.1 / WP2 量具真实读数（真实模型 + 冻结语料 + CD-7 冻结标准）',
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      judge: {
        id: M6_1_INSTRUMENT_JUDGE_ID,
        host: judge.baseUrlHost,
        model: judge.model,
        // ⚠️ **必须一起记**：它变了，跨轮采样就不再可比（CD-9 的 configKey 含它）
        reasoningEffort: judge.reasoningEffort,
        /*
         * 提示的版本号与**正文摘要**。
         *
         * 只记版本号时，"改了提示正文、忘了升版本号"会让 CD-9 把两套不同提示
         * 当成同一配置 —— 那是一种**静默的**假可比性。摘要由正文算出，不能手写。
         */
        promptVersion: M6_1_JUDGE_PROMPT_VERSION,
        promptDigest,
        /*
         * 输出预算：它是**有效配置**的一部分（预算不足 ⇒ 输出被截断 ⇒ 这条根本没判成），
         * 因此必须进证据、也进跨轮配置键。不记它就会出现"两次不同预算的读数被当成可比"。
         */
        maxTokens: judge.maxTokens,
        contractVersion: M6_1_CONTRACT_VERSION,
        limitation:
          '判定器与**被测端**是否为同一模型未在本门核对；若相同则误差相关，**不能**称独立验证。',
      },
      criteria: INSTRUMENT_VALIDITY_CRITERIA,
      /*
       * ⚠️ **分母是怎么来的**必须逐字记进证据。
       *
       * `--limit` / `--only` 都会改动分母；如果只记"跑了 5 条"，事后无法判断
       * 那 5 条是"冻结语料的前 5 条"还是"某人挑出来的 5 条" —— 而这两种读数
       * 的可信度完全不同。所以把模式与**实际条目清单**都写下来。
       */
      scope: {
        /**
         * ⚠️ **语料归属**必须逐字记进证据（工作单第 3 项）：
         * 验收语料与旧语料是两套**互不相交**的分母，报告里不许靠"总分"混过去。
         *
         * ⚠️ 版本与文件清单走 `corpusIdentity()` **同一个来源** —— 第一版这里与运行时清单
         * 各写各的，于是验收轮的清单写成了旧语料版本（见 §21.9）。
         */
        corpus: options.corpus,
        corpusVersion: corpusIdentity(options.corpus).version,
        corpusFiles: [...corpusIdentity(options.corpus).files],
        mode: options.only !== null ? 'only' : options.limit !== null ? 'limit' : 'full',
        requestedOnly: options.only === null ? null : [...options.only],
        limit: options.limit,
        /*
         * 并发只改吞吐（不进 resumeKey / configKey / 冻结件），但**要记进证据**：
         * "这份读数是用什么节奏跑出来的"是可追溯性的一部分（与 requestedOnly 同类）。
         */
        concurrency: options.concurrency,
        itemIds: items.map((item) => item.itemId),
        diagnostic: diagnosticReason !== null,
        note:
          'full = 冻结语料全部 68 条，是唯一可以出有效性判定的模式；' +
          'limit / only 是诊断档，改动分母 ⇒ verdict 一律 INCONCLUSIVE。',
      },
      verdict: decision.verdict,
      reasons: decision.reasons,
      /*
       * ---- CD-9 接线的产物（本轮采样完成后与同配置历史聚合）----
       * 接通前这里是空的，verdict 里因此一直带着 cross_run_not_measured。
       */
      crossRun: {
        reading: crossRun,
        configKey: crossAggregate.configKeyOfCurrent,
        counters: crossAggregate.counters,
        perRun: crossAggregate.perRun,
        currentSamples: currentProbeSamples.length,
      },
      recomputedFullDecision,
      metrics,
      stability,
      stabilityProbe: 'evals/m6.1/probes/stability-probe.jsonl',
      failureTally,
      probeFailureTally,
      observations,
      counting: {
        note:
          '调用失败 / 解析失败 / 弃判**都**进分母，绝不剔除' +
          '（计划书 §6.3：传输失败不能从分母偷偷剔除）。',
        /*
         * ⚠️ **实测缺陷（2026-09-23，已登记并已修）**：这一格此前内联写成
         *     `observations.filter((entry) => !entry.ok).length` ——
         *     而 `ok === false` **不只**表示传输失败：条内两次采样的**报警性不同**时也是 false。
         *     实测那一轮它 = 2，那 2 条是 `alert_state_disagreement` 的**语义分歧**，
         *     而同一份证据的 `failureTally = {}`、`parseFailures = 0`（**传输失败是 0**）
         *     ⇒ 那一格能被读成"2 条传输失败"，而它描述的不是那个东西。
         *
         * 现在逻辑搬进**纯函数** `summarizeCounting`（`m6.1-instrument.ts`），拆成三格：
         *     stillFailedAfterRetries  传输层在**重试之后**仍然失败（`callFailure ≠ null`）
         *     withoutValidReading      没形成有效读数的条目（任何原因）
         *     noValidReadingByReason   后者的原因分列 —— 语义分歧**不许**混进传输层那一格
         * 搬出去是为了能**离线**把两个方向都逼开（`retriedItemCount` 是同一个做法）。
         */
        ...summarizeCounting(observations, {
          attempted: items.length,
          judged: metrics.parsed,
          /*
           * 每条条目**名义上**要两次采样（CD-10：一次读数 = 两次一致的采样）。
           * 因此"重试过"的门槛是 `attempts > READINGS_PER_ITEM`，**不是** `> 1` ——
           * 后者把"跑满了两次采样"误报成"每条都重试过"（第一版就是这个错）。
           */
          baselineAttemptsPerItem: READINGS_PER_ITEM,
        }),
        maxAttemptsPerItem: M6_1_JUDGE_MAX_ATTEMPTS,
        minIntervalMs: M6_1_JUDGE_MIN_INTERVAL_MS,
        retryPolicy:
          '只对**传输层**失败（429 限流 / 超时 / 网络）做有界重试，且每次尝试都计数；' +
          '结果层失败（解析、截断、形状）不重试 —— 重试改变不了模型的答案。' +
          `调用之间还有 ${String(M6_1_JUDGE_MIN_INTERVAL_MS)}ms 的**节奏间隔**（限流按时间窗算，放慢才治本）。`,
      },
    },
    null,
    2
  )}\n`
  const observationPath = join(runDir, 'instrument-live.json')
  writeFileSync(observationPath, observationText, 'utf8')

  const manifestPath = writeManifestAtomic(runDir, {
    schemaVersion: 'm6.1-manifest@1',
    runId,
    testType:
      'M6.1 WP2 量具真实读数（真实模型；**不**打开真实库、**不**改生产配置、**不**接生产回复链）',
    phases: ['instrument-live'],
    startedAt,
    finishedAt: new Date().toISOString(),
    codeCommit: head,
    head,
    runRelevantTreeSha: sha256OfText(JSON.stringify(items.map((item) => item.itemId))),
    runRelevantTreeShaDefinition:
      '本清单的 runRelevantTreeSha = sha256(JSON(本次参与判定的 itemId 列表))，**不是**目录树摘要；' +
      '语料的逐文件摘要见 evals/m6.1/manifest.json。',
    workingTreeExceptions: [],
    commands: [
      {
        cmd: invokedCommand,
        exitCode: decision.verdict === 'VALID' ? 0 : 2,
      },
    ],
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch },
    fixtureRubricThresholdHashes: {
      'evals/m6.1/manifest.json': sha256OfText(
        readFileSync(join(ROOT, 'evals/m6.1/manifest.json'), 'utf8')
      ),
      'evals/m6.1/annotations/labels.json': sha256OfText(
        readFileSync(join(ROOT, 'evals/m6.1/annotations', 'labels.json'), 'utf8')
      ),
    },
    nonSecretConfigFingerprint: {
      note: '本门只记"有没有 key"，不记取值；endpoint host 与 model 已在证据里。',
      files: [],
      keys: [{ key: 'OPENAI_API_KEY', presentIn: ['(测试包装器注入)'], valueLengthByFile: {} }],
    },
    counts: {
      executed: items.length,
      completed: observations.length,
      skipped: 0,
      failed: observations.filter((entry) => !entry.ok).length,
    },
    evidence: [
      { path: relative(ROOT, observationPath).split(/[\\/]/).join('/'), sha256: sha256OfText(observationText) },
    ],
    sandboxIdentity: {
      projectLgSandboxSet: process.env.PROJECT_LG_SANDBOX !== undefined,
      cwd: ROOT,
    },
    realDbProtection: {
      definition: '本门**不碰**真实库：不 digestTree、不 statSync data/pglite、不打开 PGlite。',
      digestBefore: null,
    },
    exclusions: ['artifacts/m6.1/local/'],
    measurementSelfTest: {
      pass: true,
      cases: [
        {
          id: 'L1',
          kind: 'positive',
          proposition:
            '入口纪律：未经包装器或缺 key ⇒ 拒绝运行（判据自身的三段式在 L0 门，见 m6.1:measurement:verify）',
          observed: 'wrapper + key 均在位',
          pass: true,
        },
      ],
      note: '本门是**真实读数**，不是判据自证。',
    },
    contractVersion: M6_1_CONTRACT_VERSION,
    /*
     * ⚠️ **与证据的 `scope` 走同一个来源**（`corpusIdentity`）。
     *
     * 第一版这里写死 `M6_1_CORPUS_VERSION`（旧语料版本），于是**验收轮**的清单也写着
     * `m6.1-corpus@3`，而它实际读的是 `m6.1-acceptance@4` —— 只看清单的人会以为这轮用了旧语料。
     * 证据里的 `scope.corpusVersion` 一直是对的（可追溯性没断），但清单里那个字段
     * **描述的不是那个东西**，正是本仓库反复登记的那类缺陷。
     *
     * ⚠️ 本修复**不改任何判定规则**，但它动了判定链路文件 ⇒ 候选 id 会变。
     * 因此：正式验收两轮**仍归属于**运行时冻结的那一份
     * （`artifacts/m6.1/candidate-freeze.json` 记的 `610a3d0e4c8c`，**不覆盖**）；
     * 本修复之后的任何**新**读数都必须**另取冻结件**。
     */
    corpusVersion: corpusIdentity(options.corpus).version,
    corpusFiles: [...corpusIdentity(options.corpus).files],
    instrumentVersion: M6_1_INSTRUMENT_VERSION,
    supersedes: [],
    verdict: decision.verdict,
  })

  console.log('\n【真实读数】')
  console.log(
    `  应报警       ${String(metrics.alert.caught)}/${String(metrics.alert.total)} 召回=${String(metrics.alert.recall)}`
  )
  console.log(
    `  不应报警     ${String(metrics.nonAlert.falseAlarms)}/${String(metrics.nonAlert.total)} 误报=${String(metrics.nonAlert.rate)}`
  )
  console.log(
    `  解析失败     ${String(metrics.parseFailures)}/${String(metrics.items)} = ${String(metrics.parseFailureRate)}`
  )
  console.log(`  弃判         ${String(metrics.abstentions)} = ${String(metrics.abstentionRate)}`)
  console.log(`  调用失败     ${JSON.stringify(failureTally)}（**主循环**；探针另计 ${JSON.stringify(probeFailureTally)}）`)
  console.log(
    `  混淆矩阵     警→警 ${String(metrics.confusion.alertExpectedAlertPredicted)} · 警→安 ${String(metrics.confusion.alertExpectedNoAlertPredicted)} · 安→警 ${String(metrics.confusion.noAlertExpectedAlertPredicted)} · 安→安 ${String(metrics.confusion.noAlertExpectedNoAlertPredicted)}`
  )
  console.log(
    `  逐类分母     ${metrics.perCategory.map((entry) => `${entry.category}:${String(entry.alertCaught)}/${String(entry.alertExpected)}`).join(' ')}`
  )
  console.log(
    `  防线         a==b ${String(metrics.defenses.aEqualsBConsistency.agree)}/${String(metrics.defenses.aEqualsBConsistency.pairs)} · 成对 ${String(metrics.defenses.pairConsistency.agree)}/${String(metrics.defenses.pairConsistency.pairs)} · positionBias=${metrics.defenses.positionBias.status}`
  )
  console.log(`\n  **verdict = ${decision.verdict}**（标准 ${decision.criteriaStatus}）`)
  for (const reason of decision.reasons) {
    console.log(`    ${reason.code} :: ${reason.detail}`)
  }
  console.log(`  证据：${relative(ROOT, observationPath).split(/[\\/]/).join('/')}`)
  console.log(`  清单：${relative(ROOT, manifestPath).split(/[\\/]/).join('/')}`)
  if (decision.verdict !== 'VALID') {
    console.log(
      '\n  ⇒ INVALID/INCONCLUSIVE 也是**合格的结果**：计划书 §WP2 的出口写着"否则停在量具阶段，' +
        '不以调低产品门换取通过"。本脚本**不**提供任何"重跑到绿"的开关。'
    )
  }
  process.exit(decision.verdict === 'VALID' ? 0 : 2)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-instrument-live] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-instrument-live] 这是 MEASUREMENT INVALID，不是 PASS')
  }
  process.exit(2)
}
