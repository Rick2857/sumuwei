/**
 * 「记忆体量」覆盖率量具 —— `pnpm memory-coverage:verify`
 *
 * ============================================================================
 *  它回答什么（一句话）
 * ============================================================================
 * 对语料里的每一句话：**哪一道闸门把它挡下了**？
 *
 * ```text
 *                     用户说了一句话
 *                           │
 *    ①  后台自动路径 ──✗──  NOT-WIRED（**不在本门范围**：见语料 manifest 的 deliberatelyExcluded）
 *                           │
 *    ②  显式意图检测 ──✗──  `createExplicitMemoryIntentDetector()`（生产缺省 = 规则 + 规则型分类器）
 *                           │
 *    ③  内容抽取     ──✗──  `createRuleOnlyContentExtractor()`（生产缺省）
 *                           │
 *                        落库（**本门不测这一层**：它要库，属隔离库预演）
 * ```
 *
 * ⚠️ **它判什么、不判什么**（`AGENTS.md` §6.2 的第一问："我现在测到的东西，真的是我要判断的那个东西吗？"）
 *
 * ```text
 *   判    "这句话在**生产缺省**的显式路径下走到了哪一步"（可达性）
 *   不判  取值**正确性** —— 那是 ADR-056 与 `pnpm m6.1:extractor:repro` 的职责，本门**不重复**
 *   不判  **写入结果**（成功/失败/冲突/去重）—— 那要库，属隔离库预演（WP1/WP4）
 *   不判  **假阳**（把闲聊记成长时记忆）—— 同上
 *   不判  **覆盖率百分比** —— 本语料是**抽样**，不是总体；任何百分比都不得外推
 * ```
 *
 * ============================================================================
 *  三段式自证（`AGENTS.md` §6.7）
 * ============================================================================
 * ```text
 *   正控   真语料 ⇒ 每条实测闸门与语料声明的期望**一致** ⇒ 安静
 *   负控① 注入"**只有规则本来就能抽**的句子"的假语料
 *          ⇒ 量具**必须报出「分辨力不足」**（MEASUREMENT INVALID），而不是安静地绿
 *   负控② 把某一条的期望**故意写错** ⇒ **必须报出不一致**（证明比对真的在比）
 *   恢复   再用真语料跑一遍 ⇒ 与正控读数**逐字段相同**
 * ```
 * 计数自检：`measuredCount > 0`（§6.8）—— "检查了 0 项"与"全部一致"在输出上长得一样。
 *
 * ============================================================================
 *  语料冻结
 * ============================================================================
 * 每次运行重算语料文件的 sha256，与 `evals/memory-coverage/corpus/manifest.json` 的
 * `corpusSha256` 比对。不一致 ⇒ **FAIL**（改语料必须**有意**重刷那个字段）。
 *
 * ⚠️ 本门**不打开任何数据库**（构造属性，见 `memory-coverage-evidence.ts` 的 `DB_TOUCHED`）。
 *    退出码：0 = PASS · 3 = FAIL / MEASUREMENT INVALID。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MC_CONTRACT_VERSION,
  MC_CORPUS_VERSION,
  MC_INSTRUMENT_VERSION,
  REPO_ROOT,
  DB_TOUCHED,
  dirtyPaths,
  gitOrNull,
  makeRunId,
  selfCheckMeasurement,
  sha256,
  sourceTreeReading,
  writeManifestAtomic,
  writePayload,
} from './memory-coverage-evidence.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  MEMORY_INTENT_RULES,
  createExplicitMemoryIntentDetector,
} from '../src/kernel/app/memory/intent-detector.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { registeredPredicates } from '../src/kernel/contracts/memory-predicates.ts'

const STARTED_AT = new Date().toISOString()
const RUN_ID = makeRunId('memory-coverage')
const CORPUS_REL = 'evals/memory-coverage/corpus/memory-coverage-corpus.jsonl'
const CORPUS_MANIFEST_REL = 'evals/memory-coverage/corpus/manifest.json'
const ARTIFACT_ROOT = join(REPO_ROOT, 'artifacts', 'memory-coverage')

/* ⚠️ entityId 只允许字母数字与 `_ - :`（点号会让 `asEntityId` 直接抛 —— M6.1 实测踩过） */
const OWNER = entityRef('character', 'memory-coverage-verify')
const SPEAKER = entityRef('user', 'memory-coverage-verify')

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

type ExpectedGate =
  | 'extracted'
  | 'intent_not_detected'
  | 'content_unresolved'
  | 'content_empty'
  /**
   * 意图**被检出**，但不是 `remember`（`correct` / `forget` / `dispute`）。
   *
   * ⚠️ 它们走的是**另一条服务路径**（`service.correct()` / `forget()` / `dispute()`），
   * 而本门**只测 `remember` 的抽取层**。把它们按 `remember` 跑会量到一个不是本门要判的东西
   * —— 这不是假设：本门的**第一次运行**就因为把「更正一下，我的专业是历史学。」当 `remember`
   * 跑而报了一条"闸门不符"，那次不一致是**语料/量具的错**，不是实现的错（见基线报告）。
   */
  | 'not_remember_intent'

const GATES: readonly ExpectedGate[] = [
  'extracted',
  'intent_not_detected',
  'content_unresolved',
  'content_empty',
  'not_remember_intent',
]

interface CorpusItem {
  readonly id: string
  readonly text: string
  readonly expect: { readonly gate: ExpectedGate; readonly predicate?: string; readonly value?: string }
  readonly class: string
  readonly provenance: string
  readonly note: string
}

function loadCorpus(): { items: CorpusItem[]; bytes: Buffer; sha: string; rawSha: string } {
  const bytes = readFileSync(join(REPO_ROOT, CORPUS_REL))
  /*
   * ⚠️ **按归一化后的内容算摘要**（CRLF → LF），原始字节的摘要另记（`rawSha`）。
   *
   * 理由见 `.gitattributes` 的那一段：本机 `core.autocrlf = true`，若不归一化，
   * "别人 clone / checkout 之后语料变成 CRLF" 会让这道**语料冻结闸误报** ——
   * 而误报的闸最终会被删掉（那才是真正的损失）。两道保险都要有：
   * ① `.gitattributes` 钉死 LF；② 这里归一化。
   * ⚠️ 内容真的变了（改一个字、多一个空格、换一条期望）**仍然**会 FAIL。
   */
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n')
  const items: CorpusItem[] = []
  const problems: string[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      problems.push(`第 ${String(index + 1)} 行不是合法 JSON：${(error as Error).message}`)
      return
    }
    const item = parsed as CorpusItem
    if (typeof item.id !== 'string' || item.id === '') problems.push(`第 ${String(index + 1)} 行缺 id`)
    if (typeof item.text !== 'string') problems.push(`${String(item.id)}：缺 text`)
    if (!GATES.includes(item.expect?.gate)) {
      problems.push(`${String(item.id)}：expect.gate 非法（${String(item.expect?.gate)}）`)
    }
    if (item.expect?.gate === 'extracted' && typeof item.expect.predicate !== 'string') {
      problems.push(`${String(item.id)}：expect.gate=extracted 但没声明 predicate`)
    }
    if (typeof item.provenance !== 'string' || item.provenance === '') {
      problems.push(`${String(item.id)}：缺 provenance（每条都必须能回答"这句话是从哪来的"）`)
    }
    items.push(item)
  })
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) problems.push(`重复 id：${item.id}`)
    ids.add(item.id)
  }
  if (problems.length > 0) {
    throw new Error(`语料自身不合法（${String(problems.length)} 条）：\n  - ${problems.join('\n  - ')}`)
  }
  return { items, bytes, sha: sha256(text), rawSha: sha256(bytes) }
}

// ---------------------------------------------------------------------------
// 分类：一句话走到了哪一步
// ---------------------------------------------------------------------------

interface KeywordHit {
  readonly kind: string
  readonly keyword: string
  readonly index: number
}

/** "这句里出现了哪个意图关键词、在第几个字符" —— 事实读数，不是判断。 */
function keywordHits(text: string): KeywordHit[] {
  const hits: KeywordHit[] = []
  for (const rule of MEMORY_INTENT_RULES) {
    for (const keyword of rule.keywords) {
      const index = text.indexOf(keyword)
      if (index >= 0) hits.push({ kind: rule.kind, keyword, index })
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.keyword.length - b.keyword.length)
}

interface Reading {
  readonly id: string
  readonly class: string
  readonly text: string
  readonly expectedGate: ExpectedGate
  readonly actualGate: ExpectedGate
  readonly agree: boolean
  readonly mismatch: string | null
  readonly intentKind: string | null
  readonly detectedBy: string | null
  readonly predicate: string | null
  readonly value: string | null
  readonly predicateRegistered: boolean | null
  readonly keywordHits: readonly KeywordHit[]
  readonly provenance: string
  readonly note: string
}

/**
 * 生产缺省的显式路径：检测器用 `createExplicitMemoryIntentDetector()`（缺省 = 规则 + 规则型分类器），
 * 抽取器用 `createRuleOnlyContentExtractor()`。**两者都是 `src/main.ts` 缺省装配里的那一份。**
 */
async function judge(items: readonly CorpusItem[]): Promise<Reading[]> {
  const detector = createExplicitMemoryIntentDetector()
  const extractor = createRuleOnlyContentExtractor()
  const registered = new Set(registeredPredicates().map((spec) => spec.key))
  const readings: Reading[] = []

  for (const item of items) {
    const intent = await detector.detect(item.text)
    let actualGate: ExpectedGate
    let predicate: string | null = null
    let value: string | null = null
    let predicateRegistered: boolean | null = null

    if (intent === undefined) {
      actualGate = 'intent_not_detected'
    } else if (intent.kind !== 'remember') {
      /*
       * ⚠️ **本门只测 `remember` 的抽取层**。`correct` / `forget` / `dispute` 走
       *    `service.correct()/forget()/dispute()`（含 ADR-058 的槽位限定兜底），
       *    它们的写入结果**不是**本门能判的东西 ⇒ 如实记成 `not_remember_intent`，**不跑抽取器**。
       */
      actualGate = 'not_remember_intent'
    } else {
      const payload = intent.payload.trim()
      if (payload === '') {
        actualGate = 'content_empty'
      } else {
        const extracted = await extractor.extract({ text: payload, owner: OWNER, speaker: SPEAKER })
        if (extracted === undefined) {
          actualGate = 'content_unresolved'
        } else {
          actualGate = 'extracted'
          predicate = extracted.predicate ?? null
          predicateRegistered = predicate === null ? null : registered.has(predicate)
          const raw = (extracted.content as { value?: unknown }).value
          value = raw === undefined ? null : typeof raw === 'string' ? raw : JSON.stringify(raw)
        }
      }
    }

    const problems: string[] = []
    if (actualGate !== item.expect.gate) {
      problems.push(`闸门不符：期望 ${item.expect.gate}，实测 ${actualGate}`)
    }
    if (item.expect.gate === 'extracted' && item.expect.predicate !== undefined) {
      if (predicate !== item.expect.predicate) {
        problems.push(`槽位不符：期望 ${item.expect.predicate}，实测 ${String(predicate)}`)
      }
    }
    if (item.expect.gate === 'extracted' && item.expect.value !== undefined) {
      if (value !== item.expect.value) {
        problems.push(`取值不符：期望 ${JSON.stringify(item.expect.value)}，实测 ${JSON.stringify(value)}`)
      }
    }

    readings.push({
      id: item.id,
      class: item.class,
      text: item.text,
      expectedGate: item.expect.gate,
      actualGate,
      agree: problems.length === 0,
      mismatch: problems.length === 0 ? null : problems.join('；'),
      intentKind: intent?.kind ?? null,
      detectedBy: intent?.detectedBy ?? null,
      predicate,
      value,
      predicateRegistered,
      keywordHits: keywordHits(item.text),
      provenance: item.provenance,
      note: item.note,
    })
  }

  return readings
}

// ---------------------------------------------------------------------------
// 分辨力自检：一个"只有规则本来就能抽"的语料**不能**用来测覆盖面
// ---------------------------------------------------------------------------

interface DiscriminatingPower {
  readonly sufficient: boolean
  readonly reason: string
  readonly distinctExpectedGates: number
  readonly nonExtractedExpected: number
}

/**
 * 语料**有没有分辨力**。
 *
 * 判据（三条都要）：
 *   ① 条数 > 0
 *   ② 期望闸门**不止一种**（否则量的是一个恒等函数）
 *   ③ 至少有一条期望**不是** `extracted`（否则"规则本来就会"的集合上命中率天然很高，
 *      而这种量具与"什么都不检查"在输出上无法区分 —— `AGENTS.md` §6.7）
 */
function assessDiscriminatingPower(items: readonly CorpusItem[]): DiscriminatingPower {
  const distinct = new Set(items.map((item) => item.expect.gate))
  const nonExtracted = items.filter((item) => item.expect.gate !== 'extracted').length
  if (items.length === 0) {
    return { sufficient: false, reason: '语料为空', distinctExpectedGates: 0, nonExtractedExpected: 0 }
  }
  if (distinct.size < 2) {
    return {
      sufficient: false,
      reason: `期望闸门只有一种（${[...distinct].join('/')}）⇒ 量的是一个恒等函数`,
      distinctExpectedGates: distinct.size,
      nonExtractedExpected: nonExtracted,
    }
  }
  if (nonExtracted === 0) {
    return {
      sufficient: false,
      reason:
        '没有任何一条期望不是 `extracted` ⇒ 这个语料**只含规则本来就能抽的句子**，' +
        '命中率天然很高，量具没有分辨力（AGENTS §6.7）',
      distinctExpectedGates: distinct.size,
      nonExtractedExpected: 0,
    }
  }
  return {
    sufficient: true,
    reason:
      `期望闸门 ${String(distinct.size)} 种、其中非 \`extracted\` 的 ${String(nonExtracted)} 条 ⇒ 有分辨力`,
    distinctExpectedGates: distinct.size,
    nonExtractedExpected: nonExtracted,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`)
}

async function main(): Promise<void> {
  const failures: string[] = []
  const notes: string[] = []

  // ---- 0. 语料冻结 -------------------------------------------------------
  section('0. 语料冻结')
  const corpus = loadCorpus()
  const manifestRaw = readFileSync(join(REPO_ROOT, CORPUS_MANIFEST_REL), 'utf8')
  const corpusManifest = JSON.parse(manifestRaw) as {
    corpusSha256?: string
    itemCount?: number
    corpusVersion?: string
  }
  const frozenSha = corpusManifest.corpusSha256 ?? '(缺失)'
  const freezeOk = frozenSha === corpus.sha
  process.stdout.write(
    `  语料 ${String(corpus.items.length)} 条 · sha256 ${corpus.sha.slice(0, 16)}…\n` +
      `  冻结清单声明 ${String(frozenSha).slice(0, 16)}… ⇒ ${freezeOk ? '一致' : '**不一致**'}\n`
  )
  if (!freezeOk) {
    failures.push(
      `corpus_drift：语料 sha256=${corpus.sha}，而 ${CORPUS_MANIFEST_REL} 声明 ${String(frozenSha)}` +
        ' ⇒ 改语料必须**有意**重刷清单里的 corpusSha256（不许让语料悄悄变）'
    )
  }
  if (corpusManifest.itemCount !== undefined && corpusManifest.itemCount !== corpus.items.length) {
    failures.push(
      `corpus_item_count：清单声明 ${String(corpusManifest.itemCount)} 条，实际 ${String(corpus.items.length)} 条`
    )
  }

  // ---- 1. 分辨力自检（**在跑读数之前**）----------------------------------
  section('1. 分辨力自检（语料能不能测出东西）')
  const power = assessDiscriminatingPower(corpus.items)
  process.stdout.write(`  ${power.sufficient ? '✅' : '⛔'} ${power.reason}\n`)
  if (!power.sufficient) {
    failures.push(`insufficient_discriminating_power：${power.reason}`)
  }

  // ---- 2. 正控：真语料 ⇒ 安静 -------------------------------------------
  section('2. 正控（真语料 ⇒ 每条实测闸门与期望一致）')
  const positive = await judge(corpus.items)
  const mismatches = positive.filter((reading) => !reading.agree)
  const byActual = new Map<ExpectedGate, number>()
  const byClass = new Map<string, number>()
  for (const reading of positive) {
    byActual.set(reading.actualGate, (byActual.get(reading.actualGate) ?? 0) + 1)
    byClass.set(reading.class, (byClass.get(reading.class) ?? 0) + 1)
  }
  process.stdout.write(
    `  实测闸门：${[...byActual.entries()].map(([gate, n]) => `${gate}=${String(n)}`).join(' · ')}\n` +
      `  一致 ${String(positive.length - mismatches.length)} / 不一致 ${String(mismatches.length)}\n`
  )
  for (const reading of mismatches) {
    process.stdout.write(`  ✗ ${reading.id}（${reading.class}）：${String(reading.mismatch)}\n`)
  }
  if (mismatches.length > 0) {
    failures.push(`正控有 ${String(mismatches.length)} 条与语料声明的期望不符（见上）`)
  }

  // ---- 3. 负控①：假语料（只有规则本来就能抽的句子）⇒ 必须报分辨力不足 ----
  section('3. 负控①（注入"只有规则本来就能抽"的假语料 ⇒ 必须报分辨力不足）')
  const supportedOnly = corpus.items.filter((item) => item.expect.gate === 'extracted')
  const powerOnFake = assessDiscriminatingPower(supportedOnly)
  const controlOneFired = powerOnFake.sufficient === false
  process.stdout.write(
    `  假语料 ${String(supportedOnly.length)} 条（全部期望 extracted）⇒ ` +
      `${controlOneFired ? '✅ 如实报出分辨力不足' : '⛔ **没有报**'}\n` +
      `  理由：${powerOnFake.reason}\n`
  )
  if (!controlOneFired) {
    failures.push(
      'negative_control_1_did_not_fire：一个只含"规则本来就能抽"的语料没有被判为分辨力不足 ⇒ ' +
        '这条自检没有分辨力（它没能证明量具会在坏语料上拒绝）'
    )
  }

  // ---- 4. 负控②：故意写错的期望 ⇒ 必须报不一致 --------------------------
  section('4. 负控②（把某一条的期望故意写错 ⇒ 必须报不一致）')
  const victimIndex = corpus.items.findIndex((item) => item.expect.gate === 'extracted')
  const wrongExpectation: CorpusItem[] = corpus.items.map((item, index) =>
    index === victimIndex
      ? { ...item, expect: { ...item.expect, gate: 'content_unresolved' as ExpectedGate } }
      : item
  )
  const wrongReadings = await judge(wrongExpectation)
  const wrongMismatches = wrongReadings.filter((reading) => !reading.agree)
  const controlTwoFired = wrongMismatches.length > 0
  process.stdout.write(
    `  注入点 ${corpus.items[victimIndex]?.id ?? '(无)'} ⇒ 报出不一致 ${String(wrongMismatches.length)} 条 ⇒ ` +
      `${controlTwoFired ? '✅ 比对真的在比' : '⛔ **没有报**'}\n`
  )
  if (!controlTwoFired) {
    failures.push(
      'negative_control_2_did_not_fire：故意写错的期望没有被判为不一致 ⇒ 比对器没有分辨力'
    )
  }

  // ---- 5. 恢复：再跑一遍真语料 ⇒ 与正控逐字段相同 ------------------------
  section('5. 恢复（再跑真语料 ⇒ 与正控逐字段相同）')
  const restored = await judge(corpus.items)
  const restoreOk = JSON.stringify(restored) === JSON.stringify(positive)
  process.stdout.write(`  ${restoreOk ? '✅ 与正控读数逐字段相同' : '⛔ **与正控不同**'}\n`)
  if (!restoreOk) {
    failures.push('restore_mismatch：恢复档与正控档读数不同 ⇒ 量具不确定（同输入两次读数必须相同）')
  }

  // ---- 6. 计数自检 -------------------------------------------------------
  section('6. 计数自检（measuredCount > 0）')
  const selfCheck = selfCheckMeasurement({
    measuredCount: positive.length,
    notRunCount: 0,
    failedCount: mismatches.length,
  })
  process.stdout.write(`  ${selfCheck.verdict} —— ${selfCheck.reason}\n`)
  if (selfCheck.verdict !== 'PASS') {
    failures.push(`self_check_${selfCheck.verdict}：${selfCheck.reason}`)
  }

  // ---- 落盘 -------------------------------------------------------------
  const runDir = join(ARTIFACT_ROOT, RUN_ID)
  const registeredCount = positive.filter((reading) => reading.predicateRegistered === false).length
  if (registeredCount > 0) {
    notes.push(
      `有 ${String(registeredCount)} 条抽出的槽位**未登记**（规则路径不该出现；若出现说明登记表与规则表脱节）`
    )
  }
  const payload = {
    schemaVersion: 'memory-coverage@1',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '生产**缺省**显式路径的两道闸门：② 意图检测（规则 + 规则型分类器）与 ③ 内容抽取（纯规则）。' +
        '逐条给出"实测走到了哪一步"，并与语料声明的期望比对。',
      notVerifies:
        '不判取值正确性（ADR-056 / `m6.1:extractor:repro`）· 不判写入结果（要库）· 不判假阳 · ' +
        '不判后台路径（NOT-WIRED，归 TD-19）· 不外推覆盖率百分比（本语料是抽样）。',
      corpusVersion: MC_CORPUS_VERSION,
      contractVersion: MC_CONTRACT_VERSION,
      instrumentVersion: MC_INSTRUMENT_VERSION,
      detector: createExplicitMemoryIntentDetector().classifierName,
    },
    corpus: {
      file: CORPUS_REL,
      sha256: corpus.sha,
      sha256Definition:
        '对**归一化后**的内容求 sha256（CRLF → LF）。理由见 `.gitattributes`：' +
        '本机 `core.autocrlf = true`，不归一化会让"别人 clone 之后语料变成 CRLF"造成**误报**。' +
        '内容真的变了仍然会 FAIL。',
      rawSha256: corpus.rawSha,
      bytes: corpus.bytes.length,
      itemCount: corpus.items.length,
      frozenSha256FromManifest: frozenSha,
      freezeOk,
    },
    discriminatingPower: power,
    counts: {
      measured: positive.length,
      agree: positive.length - mismatches.length,
      mismatched: mismatches.length,
      byActualGate: Object.fromEntries([...byActual.entries()].sort()),
      byClass: Object.fromEntries([...byClass.entries()].sort()),
      extractedButUnregistered: registeredCount,
    },
    selfProof: {
      positiveControl: { readings: positive.length, mismatched: mismatches.length },
      negativeControl1_fakeCorpusWithoutUnsupported: {
        fakeItemCount: supportedOnly.length,
        reportedInsufficient: controlOneFired,
        reason: powerOnFake.reason,
      },
      negativeControl2_wrongExpectation: {
        injectedAt: corpus.items[victimIndex]?.id ?? null,
        mismatchesReported: wrongMismatches.length,
        fired: controlTwoFired,
      },
      restore: { identicalToPositive: restoreOk },
    },
    selfCheck,
    readings: positive,
    failures,
    notes,
    dbProtection: {
      dbTouched: DB_TOUCHED,
      method:
        '**构造属性**：本门只 import 纯函数 / 纯数据模块（intent-detector / content-extractor / ' +
        'memory-predicates），**不** import `src/db/**`、`src/infrastructure/persistence/**`、' +
        '`src/dev/sandbox.ts` ⇒ 它没有能力打开库。因此本门**不**用"真实库树摘要前后相同"当证据 —— ' +
        '那不是本门能观察到的东西（`m9.5:test` 同款立场）。',
    },
  }
  const payloadHash = writePayload(runDir, 'coverage.json', payload)

  const tree = sourceTreeReading(REPO_ROOT)
  const verdict = failures.length === 0 ? 'PASS' : selfCheck.verdict === 'MEASUREMENT INVALID' ? 'MEASUREMENT INVALID' : 'FAIL'
  const manifestPath = writeManifestAtomic(runDir, {
    schemaVersion: 'memory-coverage-manifest@1',
    runId: RUN_ID,
    stage: 'wp0',
    lane: 'offline',
    gateVersion: 'memory-coverage@1',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort: (gitOrNull(['rev-parse', 'HEAD']) ?? '').slice(0, 12),
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    dbKind: 'not-applicable',
    isolationProof: { dbTouched: DB_TOUCHED, method: payload.dbProtection.method },
    corpusVersion: MC_CORPUS_VERSION,
    contractVersion: MC_CONTRACT_VERSION,
    instrumentVersion: MC_INSTRUMENT_VERSION,
    corpusSha256: corpus.sha,
    command: [{ cmd: 'pnpm memory-coverage:verify', exitCode: failures.length === 0 ? 0 : 3 }],
    exitCode: failures.length === 0 ? 0 : 3,
    completion: 'complete',
    usable: verdict === 'PASS',
    verdict,
    measuredCount: positive.length,
    notRunCount: 0,
    counts: payload.counts,
    selfProof: payload.selfProof,
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(['--version']),
    },
    artifactHashes: { 'coverage.json': payloadHash },
    supersedes: null,
  })

  process.stdout.write(
    [
      '',
      '──────────────────────────────────────────────────────────────',
      `「记忆体量」覆盖率量具（WP0）：${verdict}`,
      `  语料 ${String(positive.length)} 条 · 一致 ${String(positive.length - mismatches.length)} · 不一致 ${String(mismatches.length)}`,
      `  实测闸门分布：${[...byActual.entries()].map(([gate, n]) => `${gate}=${String(n)}`).join(' · ')}`,
      ...failures.map((line) => `  ✗ ${line}`),
      ...notes.map((line) => `  · ${line}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
      '',
    ].join('\n')
  )

  if (failures.length > 0) process.exitCode = 3
}

await main()
