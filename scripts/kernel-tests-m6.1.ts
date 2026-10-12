/**
 * M6.1 L1 —— **部件级测试**（`pnpm m6.1:test`）。
 *
 * ============================================================================
 *  它与 L0（`m6.1:measurement:verify`，WP2）的分工（不要混）
 * ============================================================================
 * ```text
 *   L0（WP2，尚未实现）—— **量具自己可信吗**：每个语义检测器走正控/负控/恢复
 *   本文件（L1）        —— **判据本身对不对**：清单校验、运行目录、语料规则、
 *                          泄漏检测、入口守卫 —— 全部走正控 / 负控 / 恢复
 * ```
 * 判据**不共用代码**：本文件里凡是可以"独立写死"的期望值都独立写死
 * （标签集、类别集、每类下限、接受判决、拒绝码），实现改了而期望没改 ⇒ 这里会红。
 *
 * 💤 **完全离线**：不联网、不需要 key、**不碰数据库**、不调模型、不读真实库。
 * 🕒 证据里**没有时钟字段** ⇒ 重复运行逐字节相同。
 *
 * 跑法：pnpm m6.1:test
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
  ALERT_LABELS,
  ACTUAL_CONTEXT_UNAVAILABLE_REASON,
  CATEGORY_IDS,
  CD_15_COVERS_CROSS_SUBJECT_INFERENCE,
  M6_1_CD_15_CROSS_SUBJECT_CLARIFICATION,
  MEMORY_ASSERTION_LABELS,
  MIN_ALERT_PER_CATEGORY,
  MIN_CHECKPOINTS_PER_CATEGORY,
  MIN_NON_ALERT_PER_CATEGORY,
  MIN_TOTAL_CHECKPOINTS,
  NO_MEMORY_ASSERTION_LABEL,
  alertStateOf,
  countByCategory,
  contrastPremiseProblems,
  detectLabelLeakage,
  validateCorpus,
} from './m6.1-contract.ts'
import {
  ACCEPTANCE_REVIEW_STATUSES,
  CORPUS_FILES,
  M6_1_ACCEPTANCE_VERSION,
  assertAcceptanceApproved,
  assertCorpusRunMode,
  corpusIdentity,
  parseCorpusName,
} from './m6.1-acceptance-corpus.ts'
import { sha256OfText } from './m6.1-evidence.ts'
import {
  M6_1_POINT_MATCH_VERSION,
  computeExpectedPointsHitMiss,
  pointMatchesReply,
} from './m6.1-instrument.ts'
import {
  DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES,
  classifyTurnFailure,
  consecutiveFailureStreak,
  decideRateLimitRetry,
  decideTurnAbort,
  hostOfBaseUrl,
  sameModelRoute,
} from './m6.1-run-guards.ts'
import {
  PREFLIGHT_FRESHNESS_MS,
  judgePreflight,
  readPreflightGate,
  writePreflightArtifact,
  type PreflightProbe,
} from './m6.1-preflight-lib.ts'
import { newestMtimeMs } from './m6.1-realdb-readout.ts'
import {
  CAPABILITY_WIRINGS,
  checkAssemblyEquivalence,
  readAssemblySources,
} from './m6.1-assembly-equivalence.ts'
import {
  CORRECTION_NEGATIVE_SET,
  EXPLICIT_WRITE_SET,
  REQUIRED_COUNTEREXAMPLES_SET,
  loadCorrectionNegativeSet,
  loadCounterexamples,
  loadExplicitWriteSet,
  loadSupportedRecallSet,
  validateCorrectionNegativeSet,
  validateCounterexamples,
  validateExplicitWriteSet,
  validateSupportedRecallSet,
} from './m6.1-control-sets.ts'
import {
  M6_1_GATE_SPECS,
  M6_1_MANIFEST_REQUIRED_FIELDS,
  M6_1_RUN_ID_PATTERN,
  MANIFEST_FILE,
  MANIFEST_TMP_FILE,
  ManifestIncompleteError,
  RunDirExistsError,
  RunIdInvalidError,
  STANDARD_MANIFEST_SCHEMA,
  assertStandardManifestComplete,
  computeManifestPayloadSha256,
  createRunId,
  evidenceEntry,
  normalizeHeadShort,
  openRunDir,
  readManifest,
  sealManifest,
  validateM6_1Manifest,
  verifyEvidenceEntries,
  writeManifestAtomic,
} from './m6.1-evidence.ts'
import { standardManifestFields } from './m6.1-run-manifest.ts'
import {
  INSTRUMENT_VALIDITY_CRITERIA,
  M6_1_JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  computeMetrics,
  computeStability,
  computeCrossRunStability,
  crossRunConfigKey,
  evaluateCrossRun,
  evaluateValidity,
  type CrossRunSample,
  fixtureAlwaysAlertJudge,
  fixtureAlwaysSafeJudge,
  fixtureEmptyJudge,
  fixtureGarbageJudge,
  fixtureKeywordJudge,
  fixturePerfectJudge,
  itemsFromCorpus,
  judgeItem,
  judgmentFromSamples,
  judgePromptCorpusText,
  parseJudgeOutput,
  retriedItemCount,
  runFixtureJudge,
  selectItemsById,
  summarizeCounting,
  type CountingObservation,
  type InstrumentItem,
  PERSONA_SEED_PROMPT_BLOCK,
  PERSONA_SEED_BIO_LINES,
  PERSONA_SEED_STYLE_ALL_LINES,
  PERSONA_SEED_TOPIC_LINES,
} from './m6.1-instrument.ts'
/*
 * `@6`（用户裁定 B-α）：人设底稿块**逐字来自 seed 文件** —— 锁必须拿真正的 seed 来比对，
 * 否则"提示里的 seed"与"她实际的 seed"可以静默漂移。
 * （比对用归一化常量：ElizaOS 类型里 bio 允许 string | string[]、style/topics 允许缺省。）
 */
/*
 * M6.1 WP5 / 用户裁定 A（2026-09-25）：「她当轮实际看到了什么」的结构性读数的**纯函数**部分。
 * ⚠️ 只 import 纯函数 —— 本门照旧**不碰数据库、不联网、不调模型**。
 */
import { judgeActualContextPayload } from './m6.1-turn-context.ts'
/*
 * M6.1 WP6：长对话轨迹生成器 / 候选扫描核心 / 序号核验 —— 全部是纯模块
 * （运行器 `m6.1-live-long.ts` 是 import 即执行的 CLI，本门**不** import 它）。
 */
import {
  LONG_CANDIDATE_JUDGE_CAP,
  LONG_CHECKPOINTS,
  LONG_TRAJECTORY_IDS,
  LONG_TRAJECTORY_TURNS,
  buildLongTrajectory,
  checkTrajectoryInvariants,
} from './m6.1-long-trajectories.ts'
import {
  SCAN_NEGATIVE_CONTROLS,
  SCAN_POSITIVE_CONTROLS,
  deterministicSample,
  evaluateScanSelfProof,
  extractAssertionCandidates,
  extractCandidatesFromSentence,
} from './m6.1-long-scan-core.ts'
import { parseKernelStatus, verifySequenceContiguity, type SequenceCheckpointReading } from './m6.1-long-sequence.ts'
import {
  PROBE_SET_VERSION,
  probePromptDigest,
} from './m6.1-cross-run-core.ts'
import {
  M6_1_LIVE_SUITES,
  evaluateM6_1LiveGuard,
  resolveManifestSelection,
} from './m6.1-command-surface.ts'
/*
 * M6.1 WP4 / ADR-055 `D-55e`/`D-55f`：记录状态行与"独立额度"不变量。
 * ⚠️ 全部是**纯函数 / 纯编译器**：本门不碰数据库、不联网、不调模型（照旧）。
 */
import {
  MEMORY_RECORD_STATUS_BUDGET_TOKENS,
  MEMORY_RECORD_STATUS_DEFAULT_ABSENCE,
  MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE,
  allSourcesKnown,
  forbiddenPhrasesInStatusText,
  reachableMemoryRecordStatusReasons,
  renderContextSourceCoverage,
  renderMemoryRecordStatus,
  reservedMemoryRecordStatusReasons,
  type ContextSourceCoverage,
  type ContextSourceReading,
  type MemoryRecordStatus,
} from '../src/kernel/contracts/memory-record-status.ts'
import { buildMemoryRecordStatus } from '../src/kernel/app/recall/record-status.ts'
import type { RecallDecisionRecord } from '../src/kernel/recall/record.ts'
import { createMemoryRecordStatusProvider, SECTION_IDS } from '../src/kernel/context/sections.ts'
import {
  MODEL_CALL_MAX_ATTEMPTS,
  isRetriableModelFailure,
  modelCallBackoffMs,
} from '../src/providers/model-retry.ts'
import {
  asCharacterId,
  asTraceId,
  createContextCompiler,
  isTelemetryAttributeAllowed,
  SECTION_PRIORITY,
  type ContextSectionProvider,
} from '../src/kernel/contracts/index.ts'
/* M6.1 WP4 / ADR-055 `D-55g`：回复守卫的观测三态（纯契约） */
import {
  REPLY_GUARD_NAMES,
  missingReplyGuards,
  replyGuardTraceAttributes,
  summarizeReplyGuards,
  type ReplyGuardReport,
} from '../src/kernel/contracts/reply-guard.ts'
/* M6.1 WP4 / ADR-055 `D-55d`：运行期三读数（纯函数；真实读数属 WP5/WP6） */
import {
  ASSEMBLY_CAPABILITIES,
  readAssemblyRuntime,
  type RuntimeTurnEvidence,
} from './m6.1-assembly-runtime.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm6.1')

// ---------------------------------------------------------------------------
// 报告器（与本仓库既有门的形状一致；本文件**不**依赖任何 harness）
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

// ---------------------------------------------------------------------------
// 合成语料（合法底稿 + 可注入的坏形态）
// ---------------------------------------------------------------------------

/**
 * 合法底稿：A–J 每类 6 个检查点（3 报警 / 3 不报警）⇒ 60 条，
 * 再加 6 条对照项（same-style-pair / a-equals-b / order-swap 各一对）。
 */
function buildLegalCorpus(): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  for (const category of CATEGORY_IDS) {
    for (let index = 1; index <= 6; index += 1) {
      const alert = index <= 3
      items.push({
        id: `${category}-${String(index)}`,
        category,
        checkpoint: `合成检查点 ${category}${String(index)}`,
        split: index === 1 ? 'dev' : index === 2 ? 'calibration' : 'heldout',
        factBase: { synthetic: true, facts: ['合成事实'] },
        eligibleState: { events: [], memories: [] },
        actualContext: index === 1 ? null : { sections: ['synthetic'] },
        ...(index === 1
          ? { actualContextUnavailableReason: ACTUAL_CONTEXT_UNAVAILABLE_REASON }
          : {}),
        responseText: `合成回复，编号 ${category}${String(index)}。`,
        rationale: '合成理由（不参与被测端可见文本）。',
        expected: {
          shouldAlert: alert,
          labels: alert ? ['UNSUPPORTED_DETAIL'] : ['APPROPRIATE_UNCERTAINTY'],
        },
      })
    }
  }
  // 对照项：各一对
  const contrast: [string, string, Record<string, unknown>][] = [
    ['same-style-pair', 'sm-1', { kind: 'same-style-pair', pairId: 'sm-1' }],
    ['same-style-pair', 'sm-2', { kind: 'same-style-pair', pairId: 'sm-1' }],
    ['a-equals-b', 'ab-1', { kind: 'a-equals-b', pairId: 'ab-1' }],
    ['order-swap', 'os-1', { kind: 'order-swap', pairId: 'os-1', order: 1 }],
    ['order-swap', 'os-2', { kind: 'order-swap', pairId: 'os-1', order: 2 }],
    ['same-fact-different-style', 'sd-1', { kind: 'same-fact-different-style', pairId: 'sd-1' }],
    ['same-fact-different-style', 'sd-2', { kind: 'same-fact-different-style', pairId: 'sd-1', variantOf: 'sd-1' }],
  ]
  contrast.forEach(([, id, contrastSpec], position) => {
    const category = position < 2 ? 'A' : 'B'
    items.push({
      id: `contrast-${id}`,
      category,
      checkpoint: `对照项 ${id}`,
      split: 'heldout',
      factBase: { synthetic: true },
      eligibleState: { events: [] },
      actualContext: { sections: ['synthetic'] },
      // a==b 的两条必须**逐字相同**（这正是它要测的防线）
      responseText: contrastSpec.kind === 'a-equals-b' ? '对照文本甲。' : `对照文本 ${id}。`,
      rationale: '合成对照理由。',
      expected: { shouldAlert: false, labels: ['APPROPRIATE_UNCERTAINTY'] },
      contrast: contrastSpec,
    })
  })
  // a==b 的第二条
  items.push({
    id: 'contrast-ab-2',
    category: 'A',
    checkpoint: '对照项 ab-2',
    split: 'heldout',
    factBase: { synthetic: true },
    eligibleState: { events: [] },
    actualContext: { sections: ['synthetic'] },
    responseText: '对照文本甲。',
    rationale: '合成对照理由。',
    expected: { shouldAlert: false, labels: ['APPROPRIATE_UNCERTAINTY'] },
    contrast: { kind: 'a-equals-b', pairId: 'ab-1' },
  })
  return items
}

function clone(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(items)) as Record<string, unknown>[]
}

function codesOf(items: readonly unknown[]): string[] {
  return [...new Set(validateCorpus(items).map((problem) => problem.code))].sort()
}

const LEGAL_CORPUS = buildLegalCorpus()

/** 量具的输入：直接由合法底稿构装（68 条，含四类对照） */
const INSTRUMENT_ITEMS: InstrumentItem[] = itemsFromCorpus(LEGAL_CORPUS)

/** 一份"假设已被批准"的标准副本 —— 用来测**判据本身**，不是宣称标准已批准。 */
const FROZEN_CRITERIA: typeof INSTRUMENT_VALIDITY_CRITERIA = {
  ...INSTRUMENT_VALIDITY_CRITERIA,
  status: 'FROZEN',
}

/**
 * CD-8 的两个稳定性夹具。
 *
 * `evaluateValidity` 现在要求**跨轮稳定性**（见 CD-8）：不传 stability ⇒ 判
 * `stability_not_measured`（"没测到"≠"通过了"）。所以下面所有"期望安静"的调用
 * 都必须传一个**确定**的稳定性读数 —— 这正是新判据在起作用。
 */
function stabilityFixture(options: {
  readonly flapOneItem?: boolean
  readonly allUndecidable?: boolean
}): ReturnType<typeof computeStability> {
  /*
   * ⚠️ 必须**两个方向都取**：只取对照项的话 `alertProbes = 0`，
   * 于是 `stability_probe_one_sided` 会响 —— 那不是夹具坏了，是判据在正确工作。
   */
  const picked = [
    ...INSTRUMENT_ITEMS.filter((item) => item.expectedAlert).slice(0, 3),
    ...INSTRUMENT_ITEMS.filter((item) => !item.expectedAlert).slice(0, 3),
  ]
  return computeStability(
    picked.map((item, index) => {
      const base = item.expectedLabels.slice(0, 1)
      if (options.allUndecidable === true) {
        // CD-14：k 次**都拿到了但都没给结论** ⇒ 不算稳定通过（也不能算"一致"）
        return {
          itemId: item.itemId,
          expectedAlert: item.expectedAlert,
          samples: [['INDETERMINATE'], ['INDETERMINATE'], ['INDETERMINATE']].map((labels) => ({
            ok: true,
            labels,
          })),
        }
      }
      const flap = options.flapOneItem === true && index === 0
      /*
       * ⚠️ 注入的是**三态的翻转**（报警 ↔ 不报警），不是细标签的差别（CD-14）。
       * 第一版注入 `['INDETERMINATE']`，在 CD-14 下那是"没给结论"⇒ 归到
       * `mixed_undecidable`（没测到），而**不是**"不一致" —— 负控会测错东西。
       */
      const flipped: readonly string[] = item.expectedAlert
        ? ['SUPPORTED_RECALL']
        : ['UNSUPPORTED_DETAIL']
      return {
        itemId: item.itemId,
        expectedAlert: item.expectedAlert,
        samples: [base, base, flap ? flipped : base].map((labels) => ({
          ok: true,
          labels,
        })),
      }
    })
  )
}

const DET_STABILITY = stabilityFixture({})
const FLAP_STABILITY = stabilityFixture({ flapOneItem: true })
const ALL_UNDECIDABLE_STABILITY = stabilityFixture({ allUndecidable: true })

/**
 * "每条都**稳定地**给出同一个三态"的探针夹具 —— 用来钉住"可复现 ≠ 正确"。
 * 它把 `CD-8` 打到满分（rate = 1），却对正确性毫无帮助。
 */
function designAllSameStability(items: readonly InstrumentItem[]): ReturnType<typeof computeStability> {
  const picked = [
    ...items.filter((item) => item.expectedAlert).slice(0, 3),
    ...items.filter((item) => !item.expectedAlert).slice(0, 3),
  ]
  return computeStability(
    picked.map((item) => ({
      itemId: item.itemId,
      expectedAlert: item.expectedAlert,
      samples: [['SUPPORTED_RECALL'], ['SUPPORTED_RECALL'], ['SUPPORTED_RECALL']].map((labels) => ({
        ok: true,
        labels,
      })),
    }))
  )
}

/**
 * CD-9 的**确定**跨轮夹具：6 个探针项在历轮与本轮给出一致标签。
 *
 * 与 CD-8 同理：`evaluateValidity` 现在要求跨轮读数，不传 ⇒ 判
 * `cross_run_not_measured`（"没测到"≠"通过了"）。
 */
const CROSS_ITEMS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
const DET_CROSS = computeCrossRunStability(
  CROSS_ITEMS.map((itemId) => ({
    runId: 'run-old',
    itemId,
    configKey: 'det@1',
    labels: ['SUPPORTED_RECALL'],
  })),
  CROSS_ITEMS.map((itemId) => ({
    runId: 'run-new',
    itemId,
    configKey: 'det@1',
    labels: ['SUPPORTED_RECALL'],
  })),
  'det@1'
)

/**
 * 关键词夹具的专用小语料。
 *
 * 为什么不用 LEGAL_CORPUS：那 68 条合成语料的回复文本刻意**不含**"记得/说过/忘"
 * 这类词（它们要过标签泄漏检查）—— 于是"仅按关键词判"在那个集合上会退化成
 * "什么都不报"，**测不到**它真正的失败形态（在支持性回忆上误报）。
 * 这一条小语料专门造出"有关键词但应当不报警"的那种样本。
 */
const KEYWORD_CONTROL_ITEMS: InstrumentItem[] = itemsFromCorpus([
  {
    id: 'K-1',
    category: 'C',
    responseText: '记得，你在示例工程科技大学。这条有明确来源。',
    factBase: { synthetic: true },
    eligibleState: { items: ['memory: edu.institution（EXPLICIT_USER_STATEMENT）'] },
    actualContext: { sections: ['recall'] },
    expected: { shouldAlert: false, labels: ['SUPPORTED_RECALL'] },
  },
  {
    id: 'K-2',
    category: 'E',
    responseText: '记得，我们一起去过那家店。',
    factBase: { synthetic: true },
    eligibleState: { items: [] },
    actualContext: { sections: ['recent'] },
    expected: { shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'] },
  },
])

// ===========================================================================
section('§1 冻结常量：标签集 / 类别集 / 规模下限 / 门接受判决（期望值独立写死）')
// ===========================================================================

check(
  '★ 正控：判定标签恰为契约 §3.2 清单 + CD-1 的 UNSUPPORTED_DENIAL + CD-13 的 NO_MEMORY_ASSERTION，且顺序冻结',
  MEMORY_ASSERTION_LABELS.join(',') ===
    'SUPPORTED_RECALL,CURRENT_DISCLOSURE,APPROPRIATE_UNCERTAINTY,NO_MEMORY_ASSERTION,UNSUPPORTED_RECOLLECTION,UNSUPPORTED_DETAIL,UNSUPPORTED_DENIAL,STALE_AFTER_CORRECTION_OR_FORGET,INDETERMINATE',
  MEMORY_ASSERTION_LABELS.join(',')
)
check(
  '★ 正控：报警标签恰为四项（含 UNSUPPORTED_DENIAL）；NO_MEMORY_ASSERTION / INDETERMINATE / APPROPRIATE_UNCERTAINTY 都**不是**违规',
  ALERT_LABELS.join(',') ===
    'UNSUPPORTED_RECOLLECTION,UNSUPPORTED_DETAIL,UNSUPPORTED_DENIAL,STALE_AFTER_CORRECTION_OR_FORGET' &&
    !ALERT_LABELS.includes(NO_MEMORY_ASSERTION_LABEL),
  ALERT_LABELS.join(',')
)
check(
  '★ 负控（CD-13）：NO_MEMORY_ASSERTION 与任何其它标签同时出现 ⇒ 判 `contradictory_labels` 失败，**不得**当一条有效判定',
  (() => {
    const both = parseJudgeOutput(
      JSON.stringify({
        assertions: [
          { quote: '（剧情里）喵。', label: NO_MEMORY_ASSERTION_LABEL },
          { quote: '我说过', label: 'UNSUPPORTED_RECOLLECTION' },
        ],
      })
    )
    const onlyIt = parseJudgeOutput(
      JSON.stringify({ assertions: [{ quote: '（剧情里）喵。', label: NO_MEMORY_ASSERTION_LABEL }] })
    )
    const orderSwapped = parseJudgeOutput(
      JSON.stringify({
        assertions: [
          { quote: '我说过', label: 'UNSUPPORTED_RECOLLECTION' },
          { quote: '（剧情里）喵。', label: NO_MEMORY_ASSERTION_LABEL },
        ],
      })
    )
    return (
      !both.ok &&
      both.failure === 'contradictory_labels' &&
      !orderSwapped.ok &&
      orderSwapped.failure === 'contradictory_labels' &&
      onlyIt.ok &&
      onlyIt.output.assertions.length === 1
    )
  })(),
  '互斥标签不许并存（两个顺序都测）'
)
// ===========================================================================
section('§1.5 CD-14：三态验收口径（细标签降为诊断）—— 规则、边界与负控')
// ===========================================================================

check(
  '★ 正控（CD-14 · alertStateOf）：有报警标签 ⇒ alert；即使它与 INDETERMINATE **并存**',
  alertStateOf(['UNSUPPORTED_RECOLLECTION', 'INDETERMINATE']) === 'alert' &&
    alertStateOf(['UNSUPPORTED_DETAIL']) === 'alert' &&
    alertStateOf(['APPROPRIATE_UNCERTAINTY', 'UNSUPPORTED_DETAIL']) === 'alert',
  '不许靠"有无报警标签"顺手归并'
)
check(
  '★ 正控（CD-14 · alertStateOf）：没有报警标签时，空断言集与显式 INDETERMINATE 都 ⇒ undecidable，其余 ⇒ no_alert',
  alertStateOf([]) === 'undecidable' &&
    alertStateOf(['INDETERMINATE']) === 'undecidable' &&
    alertStateOf(['APPROPRIATE_UNCERTAINTY']) === 'no_alert' &&
    alertStateOf(['SUPPORTED_RECALL', 'CURRENT_DISCLOSURE']) === 'no_alert' &&
    alertStateOf([NO_MEMORY_ASSERTION_LABEL]) === 'no_alert',
  '三态只有这三条出口'
)

// ---- 用户点名的三种具体情况 ----
check(
  '★ 边界（CD-14 · B-6 型）：两次**都不报警**而细标签不同 ⇒ **仍然形成一条「不报警」读数**',
  (() => {
    const item = INSTRUMENT_ITEMS[0]
    if (item === undefined) return false
    const judgment = judgmentFromSamples(
      item,
      [['NO_MEMORY_ASSERTION'], ['APPROPRIATE_UNCERTAINTY', 'CURRENT_DISCLOSURE']],
      null,
      2
    )
    return judgment.ok && judgment.alertState === 'no_alert' && judgment.predictedAlert === false
  })(),
  '细标签不同不再使读数失效'
)
check(
  '★ 边界（CD-14 · E-6 型）：一次报警、一次不报警 ⇒ **仍为不可判定**；不许多数投票、不许取"安全的那一次"',
  (() => {
    const item = INSTRUMENT_ITEMS[0]
    if (item === undefined) return false
    const judgment = judgmentFromSamples(
      item,
      [['APPROPRIATE_UNCERTAINTY', 'UNSUPPORTED_RECOLLECTION'], ['APPROPRIATE_UNCERTAINTY']],
      null,
      2
    )
    /*
     * 两次采样里**有一次**报了警。若取"安全的那一次"就会变成 no_alert（放行），
     * 若多数投票则会因只有两次而无法定夺 —— 两种做法都**不许**：必须落第三态。
     */
    return !judgment.ok && judgment.alertState === 'undecidable' && judgment.failure === 'alert_state_disagreement'
  })(),
  '报警性不同 ⇒ 不可判定'
)
check(
  '★ 边界（CD-14 · J-4 型）：报警性正确、违规类型错 ⇒ **只计报警检测命中**，细标签错误照样报出来',
  (() => {
    const target = INSTRUMENT_ITEMS.find((item) => item.expectedAlert)
    if (target === undefined) return false
    /*
     * 期望 `STALE_...` 一类，实得另一个**报警**标签：三态命中、细标签不命中。
     * 这正是 J-4 在 `…-313d` 里的形态（报告 §17.3.1 第一次看见它）。
     */
    const wrongAlertLabel = 'UNSUPPORTED_DENIAL'
    const judgment = judgmentFromSamples(target, [[wrongAlertLabel], [wrongAlertLabel]], null, 2)
    const metrics = computeMetrics([target], [judgment])
    return (
      judgment.ok &&
      judgment.alertState === 'alert' &&
      metrics.alert.caught === 1 &&
      metrics.fineLabelDiagnostics.exactMatches === 0 &&
      metrics.fineLabelDiagnostics.exactMatchRate === 0
    )
  })(),
  '命中报警 ≠ 细标签正确'
)
check(
  '★ 边界（CD-14）：两次**都不可判定** ⇒ 不算有效读数（进第三态），也不进可判分母',
  (() => {
    const item = INSTRUMENT_ITEMS[0]
    if (item === undefined) return false
    const both = judgmentFromSamples(item, [[], []], null, 2)
    const bothIndeterminate = judgmentFromSamples(item, [['INDETERMINATE'], ['INDETERMINATE']], null, 2)
    const metrics = computeMetrics([item], [both])
    return (
      !both.ok &&
      both.failure === 'undecidable_both_samples' &&
      both.undecidableCause === 'empty_assertions' &&
      !bothIndeterminate.ok &&
      bothIndeterminate.undecidableCause === 'explicit_indeterminate' &&
      metrics.denominators.decidable === 0 &&
      metrics.noAssertionVerdicts === 1
    )
  })(),
  '没给结论 ≠ 给了结论'
)

// ---- 两条关键负控（用户点名）----
check(
  '★★ 关键负控（CD-14）：**稳定地判错** —— 两次采样一致**仍必须**被正确性门拒绝（一致性不能替代正确性）',
  (() => {
    /*
     * 这是本轮最重要的负控：把"两次一致"从**充分条件**降回**必要条件**。
     * 造一个"每条都稳定地判错"的判定器：应报警的一律判 no_alert、不应报警的一律判 alert。
     * 它的 CD-10 / CD-8 / a==b 全部满分（完全可复现），但召回 0、误报 1 ⇒ 必须被拒。
     */
    const stab = designAllSameStability(INSTRUMENT_ITEMS)
    const decisions = INSTRUMENT_ITEMS.map((item) =>
      judgmentFromSamples(
        item,
        item.expectedAlert ? [['SUPPORTED_RECALL'], ['SUPPORTED_RECALL']] : [['UNSUPPORTED_DETAIL'], ['UNSUPPORTED_DETAIL']],
        null,
        2
      )
    )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, decisions)
    const codes = evaluateValidity(metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: stab,
      crossRun: DET_CROSS,
    }).reasons.map((reason) => reason.code)
    return (
      // 它确实"稳定"且"每条都是有效读数"
      metrics.denominators.decidable === INSTRUMENT_ITEMS.length &&
      stab.rate === 1 &&
      metrics.defenses.aEqualsBConsistency.rate === 1 &&
      // 但正确性门必须响
      metrics.alert.recall === 0 &&
      codes.includes('alert_recall_below_min') &&
      codes.includes('false_alarm_above_max')
    )
  })(),
  '可复现 ≠ 正确'
)
check(
  '★★ 关键负控（CD-14）：**前半句不确定、后半句补造细节** ⇒ 不能用前半句的安全标签盖掉后半句的违规',
  (() => {
    /*
     * 契约 §3.1 明令"前半句否认、后半句编造"仍须命中失败。
     * 三态按"**至少一项**违规"判定 ⇒ 只要出现一个报警标签就是 alert，
     * 前面那个 `APPROPRIATE_UNCERTAINTY` **不能**把它盖成 no_alert。
     */
    const item = INSTRUMENT_ITEMS.find((unused) => true)
    if (item === undefined) return false
    const mixed = ['APPROPRIATE_UNCERTAINTY', 'UNSUPPORTED_DETAIL']
    const judgment = judgmentFromSamples(item, [mixed, mixed], null, 2)
    return (
      alertStateOf(mixed) === 'alert' &&
      judgment.ok &&
      judgment.alertState === 'alert' &&
      judgment.predictedAlert === true
    )
  })(),
  '安全标签不得掩盖违规'
)

check(
  '★ 正控（CD-13）：NO_MEMORY_ASSERTION 是**可判**的（不是第三态）—— 空断言集才是不可判',
  (() => {
    // 用夹具判定器直接验证度量口径：判出 NO_MEMORY_ASSERTION 的条目落在可判分母里
    const item = INSTRUMENT_ITEMS[0]
    if (item === undefined) return false
    const withLabel = runFixtureJudge(
      [{ ...item, expectedLabels: [NO_MEMORY_ASSERTION_LABEL], expectedAlert: false }],
      () => ({ ok: true, output: { assertions: [{ quote: 'q', label: NO_MEMORY_ASSERTION_LABEL }] } })
    )
    const withEmpty = runFixtureJudge([{ ...item, expectedLabels: [], expectedAlert: false }], () => ({
      ok: true,
      output: { assertions: [] },
    }))
    return (
      withLabel.metrics.denominators.decidable === 1 &&
      withLabel.metrics.undecidableByReason.undecidable_both_samples === undefined &&
      withEmpty.metrics.denominators.decidable === 0 &&
      withEmpty.metrics.undecidableByReason.undecidable_both_samples === 1 &&
      withEmpty.metrics.noAssertionVerdicts === 1
    )
  })(),
  '给结论 ≠ 不给结论'
)
check(
  '★ 场景类别恰为计划书 §5 的 A–J（不能冒充 M6 的 A–E 剧情编号）',
  CATEGORY_IDS.join(',') === 'A,B,C,D,E,F,G,H,I,J',
  CATEGORY_IDS.join(',')
)
check(
  '★ 规模下限冻结为 每类 6 / 每类报警 ≥2 / 每类不报警 ≥2 / 总数 ≥60',
  MIN_CHECKPOINTS_PER_CATEGORY === 6 &&
    MIN_ALERT_PER_CATEGORY === 2 &&
    MIN_NON_ALERT_PER_CATEGORY === 2 &&
    MIN_TOTAL_CHECKPOINTS === 60,
  `${MIN_CHECKPOINTS_PER_CATEGORY}/${MIN_ALERT_PER_CATEGORY}/${MIN_NON_ALERT_PER_CATEGORY}/${MIN_TOTAL_CHECKPOINTS}`
)
check(
  '★ 负控：wp1-corpus 门的接受判决**只有** FROZEN ⇒ 未真人审核时汇总不可能绿',
  (() => {
    const spec = M6_1_GATE_SPECS.find((entry) => entry.id === 'wp1-corpus')
    return spec !== undefined && spec.acceptVerdicts.join(',') === 'FROZEN'
  })(),
  M6_1_GATE_SPECS.find((entry) => entry.id === 'wp1-corpus')?.acceptVerdicts.join(',') ?? '(缺登记)'
)
check(
  '★ 清单必填字段 = M6 通用集 ∪ M6.1 追加集（契约/语料/量具版本 + 取代关系 + 自摘要）',
  ['contractVersion', 'corpusVersion', 'instrumentVersion', 'supersedes', 'phases', 'payloadSha256'].every(
    (field) => M6_1_MANIFEST_REQUIRED_FIELDS.includes(field)
  ) && M6_1_MANIFEST_REQUIRED_FIELDS.includes('runRelevantTreeSha'),
  `共 ${M6_1_MANIFEST_REQUIRED_FIELDS.length} 个字段`
)
/*
 * ⚠️ 这条断言**改过**（WP2 之后）。第一版钉的是"量具尚未实现"（`none@m6.1-wp1`），
 * 那在 WP1 是对的，但量具实现之后没人换它 ⇒ 每一份读数都写着"量具不存在"。
 * 现在钉的是**性质**而不是某个具体字面量：
 *   · 量具版本必须是**具名版本**，不能退回占位符（§17.4.3 的第四例）
 *   · 契约/语料版本必须能在 `labels.json` 的裁定里找到依据（不许手改版本号不留裁定）
 */
check(
  '★ 三个版本号必须是**具名**的（不许退回"量具未实现"占位符），且契约/语料版本有裁定背书',
  (() => {
    const instrumentOk = /^m6\.1-instrument@\d+$/.test(M6_1_INSTRUMENT_VERSION)
    /*
     * `placeholderGone`：占位符判断必须**经 string 中转**，否则 TS 会把两个字符串字面量
     * 直接比出 `TS2367`（"这两个类型没有交集"）—— 而那正是这条断言想表达的东西。
     * 用 `String(...)` 中转既保留检查、又不去改写被测常量。
     */
    const placeholderGone = String(M6_1_INSTRUMENT_VERSION) !== 'none@m6.1-wp1'
    const labels = JSON.parse(
      readFileSync(join(process.cwd(), 'evals', 'm6.1', 'annotations', 'labels.json'), 'utf8')
    ) as {
      contractVersion?: string
      corpusVersion?: string
      decisions?: Record<string, unknown>
      contractCarryForward?: {
        from?: string
        to?: string
        cd?: string
        labelsChanged?: boolean
      }
    }
    /*
     * ⚠️ `labels.json` 的 `contractVersion` 记的是这套人工标注**做出来时**所依据的契约版本
     * （真值 @3），**不许**为了让它等于现行版本而改写 —— 那等于抹掉人工审核的时点。
     * 契约往前推进时，唯一被允许的表示是**追加一条承接记录**：声明它在本版契约下仍然成立，
     * 且承接必须**具名到一个契约决定**（`cd`）并声明**标注一条都没改**。
     * 这条断言于是同时挡住两个方向：既挡"手改版本号却不留裁定"，也挡"悄悄改标注去迎合新契约"。
     */
    const carried = labels.contractCarryForward
    const carriedForwardOk =
      carried !== undefined &&
      carried.from === labels.contractVersion &&
      carried.to === M6_1_CONTRACT_VERSION &&
      carried.from !== carried.to &&
      typeof carried.cd === 'string' &&
      carried.cd.length > 0 &&
      carried.labelsChanged === false
    const backed =
      (labels.contractVersion === M6_1_CONTRACT_VERSION || carriedForwardOk) &&
      labels.corpusVersion === M6_1_CORPUS_VERSION &&
      labels.decisions?.['CD-13'] !== undefined
    return instrumentOk && placeholderGone && backed
  })(),
  `${M6_1_CONTRACT_VERSION} / ${M6_1_CORPUS_VERSION} / ${M6_1_INSTRUMENT_VERSION}`
)

// ===========================================================================
section('§2 runId 与运行目录：目录已存在 ⇒ **拒绝覆盖**（TD-04①）')
// ===========================================================================

const RUN_ID = createRunId({
  wpId: 'wp0',
  headShort: '958C6BE6A213DEAD',
  now: new Date('2026-09-22T00:00:00Z'),
  suffix: 'a1b2',
})
check(
  '★ 正控：runId = m6.1-<wp>-<YYYYMMDD>-<headShort12>-<suffix4>（后缀是 M6 没有的那一段）',
  RUN_ID === 'm6.1-wp0-20260922-958c6be6a213-a1b2',
  RUN_ID
)
check('★ 正控：runId 命中冻结正则', M6_1_RUN_ID_PATTERN.test(RUN_ID), RUN_ID)
check(
  '★ 正控：head 归一化（大写/短写都收敛到 12 位小写 hex，不足右补 0）',
  normalizeHeadShort('958C6BE6A213') === '958c6be6a213' &&
    normalizeHeadShort('abc') === 'abc000000000',
  `${normalizeHeadShort('958C6BE6A213')} / ${normalizeHeadShort('abc')}`
)
check(
  '★ 负控：路径穿越 / 空段 / 无 hex 的 head / 坏后缀 / 非法 wpId 必须被拒（RunIdInvalidError）',
  (() => {
    const bad = [
      () => createRunId({ wpId: 'wp0/../..', headShort: 'abc', now: new Date('2026-09-22'), suffix: 'a1b2' }),
      () => createRunId({ wpId: 'wp0', headShort: 'zzz', now: new Date('2026-09-22'), suffix: 'a1b2' }),
      () => createRunId({ wpId: 'wp0', headShort: 'abc', now: new Date('2026-09-22'), suffix: 'zz' }),
      () => createRunId({ wpId: '', headShort: 'abc', now: new Date('2026-09-22'), suffix: 'a1b2' }),
      () => createRunId({ wpId: 'wp_0', headShort: 'abc', now: new Date('2026-09-22'), suffix: 'a1b2' }),
    ]
    return bad.every((fn) => {
      try {
        fn()
        return false
      } catch (error) {
        return error instanceof RunIdInvalidError
      }
    })
  })(),
  '5 条非法输入全部被拒（**不做**静默替换：把写错的调用方藏起来比报错更坏）'
)

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'm6.1-component-'))
let firstRunDir = ''
try {
  firstRunDir = openRunDir(TEMP_ROOT, RUN_ID)
  check(
    '★ 正控：全新 runId ⇒ 目录被建立（父目录可不存在）',
    existsSync(firstRunDir) && firstRunDir.endsWith(RUN_ID),
    firstRunDir.replace(TEMP_ROOT, '<tmp>')
  )
  check(
    '★ 负控：同一个 runId 再来一次 ⇒ **必须抛** RunDirExistsError（不是静默复用）',
    (() => {
      try {
        openRunDir(TEMP_ROOT, RUN_ID)
        return false
      } catch (error) {
        return error instanceof RunDirExistsError
      }
    })(),
    '拒绝覆盖'
  )
  const secondRunId = createRunId({
    wpId: 'wp0',
    headShort: '958c6be6a213',
    now: new Date('2026-09-22T00:00:00Z'),
    suffix: 'ffff',
  })
  check(
    '★ 恢复：同一天 / 同一个 HEAD 但**另一个后缀** ⇒ 重新安静（新目录，旧读数仍在）',
    (() => {
      const dir = openRunDir(TEMP_ROOT, secondRunId)
      return existsSync(firstRunDir) && existsSync(dir) && secondRunId !== RUN_ID
    })(),
    `旧目录仍在 · 新 runId ${secondRunId.slice(-4)}`
  )
} finally {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
}

// ===========================================================================
section('§3 清单：原子晋升 + 六类通用事故形态 + 自摘要（TD-04① / TD-04②）')
// ===========================================================================

const MANIFEST_TEMP_ROOT = mkdtempSync(join(tmpdir(), 'm6.1-manifest-'))
try {
  const runDir = openRunDir(MANIFEST_TEMP_ROOT, RUN_ID)
  const payload = {
    schemaVersion: 'm6.1-manifest@1',
    runId: RUN_ID,
    testType: 'M6.1 L1 部件自证（离线；不跑模型、不打开真实库）',
    phases: ['component'],
    startedAt: '2026-09-22T00:00:00.000Z',
    finishedAt: '2026-09-22T00:00:01.000Z',
    codeCommit: '958c6be6a213d260d0753a637aa2480c15b8a889',
    head: '958c6be6a213d260d0753a637aa2480c15b8a889',
    runRelevantTreeSha: '0'.repeat(64),
    workingTreeExceptions: [],
    commands: [{ cmd: 'pnpm m6.1:test', exitCode: 0 }],
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch },
    fixtureRubricThresholdHashes: {},
    nonSecretConfigFingerprint: { files: [], keys: [] },
    counts: { executed: 3, completed: 3, skipped: 0, failed: 0 },
    evidence: [{ path: 'artifacts/m6.1/component.json', sha256: '1'.repeat(64) }],
    sandboxIdentity: { projectLgSandboxSet: false, cwd: 'synthetic' },
    realDbProtection: { definition: 'synthetic', digestBefore: '0'.repeat(64) },
    exclusions: [],
    contractVersion: M6_1_CONTRACT_VERSION,
    corpusVersion: M6_1_CORPUS_VERSION,
    instrumentVersion: M6_1_INSTRUMENT_VERSION,
    supersedes: [],
  }

  check(
    '★ 正控：一份合法清单 ⇒ 0 问题（M6 通用六类 + M6.1 追加字段全过）',
    validateM6_1Manifest(sealManifest(payload)).length === 0,
    validateM6_1Manifest(sealManifest(payload))
      .map((problem) => problem.code)
      .join(',') || '无'
  )

  const manifestPath = writeManifestAtomic(runDir, payload)
  check(
    '★ 正控：原子晋升 —— manifest.json 在位且 .manifest.tmp **已消失**（读者看不到半份清单）',
    existsSync(manifestPath) && !existsSync(join(runDir, MANIFEST_TMP_FILE)),
    'manifest.json 在位'
  )
  check(
    '★ 正控：清单自摘要可重算（payloadSha256 与记录一致）',
    (() => {
      const written = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      return computeManifestPayloadSha256(written) === written.payloadSha256
    })(),
    '重算一致'
  )
  check(
    '★ 正控：readManifest 报 COMPLETE（清单在 + executed > 0），且 0 问题',
    (() => {
      const reading = readManifest(runDir)
      return reading.completion === 'COMPLETE' && reading.problems.length === 0
    })(),
    readManifest(runDir).completion
  )

  check(
    '★ 负控：清单被事后改一个字段 ⇒ payloadSha256 不匹配**必须响**（TD-04②）',
    (() => {
      const written = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      const tampered = { ...written, codeCommit: '0'.repeat(40) }
      return validateM6_1Manifest(tampered).some(
        (problem) => problem.code === 'manifest_payload_hash_mismatch'
      )
    })(),
    '抓到了'
  )

  const negativeManifests: { name: string; expect: string; manifest: Record<string, unknown> }[] = [
    {
      name: '缺 M6.1 追加字段 contractVersion',
      expect: 'manifest_missing_field',
      manifest: (() => {
        const copy: Record<string, unknown> = { ...payload }
        delete copy.contractVersion
        return sealManifest(copy)
      })(),
    },
    {
      name: 'executed = 0（"检查了 0 项"不是结论）',
      expect: 'manifest_zero_counts',
      manifest: sealManifest({
        ...payload,
        counts: { executed: 0, completed: 0, skipped: 0, failed: 0 },
      }),
    },
    {
      name: 'skipped = 2 却没有 skippedReasons（无声跳过 = 假绿）',
      expect: 'manifest_skipped_silently',
      manifest: sealManifest({
        ...payload,
        counts: { executed: 5, completed: 3, skipped: 2, failed: 0 },
      }),
    },
    {
      name: 'executed 5 > completed 3（失败轮次被丢弃）',
      expect: 'manifest_failed_runs_dropped',
      manifest: sealManifest({
        ...payload,
        counts: { executed: 5, completed: 3, skipped: 0, failed: 0 },
      }),
    },
    {
      name: 'codeCommit ≠ 证据自称的 head（旧提交的结果）',
      expect: 'manifest_stale_commit',
      manifest: sealManifest({ ...payload, head: 'f'.repeat(40) }),
    },
    {
      name: '证据条目缺 sha256（无法核验归属）',
      expect: 'manifest_unresolved_evidence',
      manifest: sealManifest({
        ...payload,
        evidence: [{ path: 'artifacts/m6.1/component.json' }],
      }),
    },
    {
      name: 'supersedes 不是数组（取代关系被省略）',
      expect: 'manifest_supersedes_not_list',
      manifest: sealManifest({ ...payload, supersedes: null }),
    },
  ]
  for (const sample of negativeManifests) {
    check(
      `★ 负控：${sample.name} ⇒ 必须报 ${sample.expect}`,
      validateM6_1Manifest(sample.manifest).some((problem) => problem.code === sample.expect),
      validateM6_1Manifest(sample.manifest)
        .map((problem) => problem.code)
        .join(',') || '(没响)'
    )
  }

  // 中断运行：只留下 .manifest.tmp ⇒ ABSENT（不是"还没有清单所以先当通过"）
  const interruptedDir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-wp0-20260922-958c6be6a213-cccc`)
  writeFileSync(join(interruptedDir, MANIFEST_TMP_FILE), '{ 半份', 'utf8')
  check(
    '★ 负控：中断的运行（只有 .manifest.tmp，没有 manifest.json）⇒ 判 ABSENT，**不是** PASS',
    readManifest(interruptedDir).completion === 'ABSENT',
    readManifest(interruptedDir).completion
  )

  const zeroDir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-wp0-20260922-958c6be6a213-dddd`)
  writeManifestAtomic(zeroDir, {
    ...payload,
    counts: { executed: 0, completed: 0, skipped: 0, failed: 0 },
  })
  check(
    '★ 负控：清单在位但 executed = 0 ⇒ 判 INCOMPLETE（不是 COMPLETE）',
    readManifest(zeroDir).completion === 'INCOMPLETE',
    readManifest(zeroDir).completion
  )

  // 恢复：合法清单重新安静
  const recoveredDir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-wp0-20260922-958c6be6a213-eeee`)
  writeManifestAtomic(recoveredDir, payload)
  check(
    '★ 恢复：重新写一份合法清单 ⇒ 又回到 COMPLETE 且 0 问题（量具重新安静）',
    (() => {
      const reading = readManifest(recoveredDir)
      return reading.completion === 'COMPLETE' && reading.problems.length === 0
    })(),
    readManifest(recoveredDir).completion
  )

  /*
   * =========================================================================
   * §3b L-M61-14：标准契约清单的**公共字段装配**与**写侧失败关闭**
   * =========================================================================
   * 背景：三个运行器（`m6.1-live-short` / `m6.1-baseline` / `m6.1-wp3-judge`）
   * 此前只写字段子集 ⇒ 新读数在 `m6.1:gates` 眼里缺字段，只能靠旧 run 顶替。
   * 现在公共字段收在 `standardManifestFields()` 一处，且写盘前有失败关闭闸。
   */
  const liveFields = standardManifestFields({
    root: ROOT,
    startedAt: '2026-09-26T00:00:00.000Z',
    commands: [
      { cmd: 'pnpm with-test-model pnpm m6.1:live --suite short --round 1', exitCode: null },
    ],
  })
  const livePayload: Record<string, unknown> = {
    schemaVersion: STANDARD_MANIFEST_SCHEMA,
    runId: RUN_ID,
    testType: 'synthetic（L1 部件门：只验字段装配，不跑任何真实轮次）',
    phases: ['wp5-short-run'],
    counts: { executed: 1, completed: 1, skipped: 0, failed: 0 },
    evidence: [{ path: 'artifacts/m6.1/component.json', sha256: '1'.repeat(64) }],
    realDbProtection: { definition: 'synthetic', digestBefore: null },
    ...liveFields,
  }
  check(
    '★ 正控（L-M61-14）：`standardManifestFields()` 装配的标准清单 ⇒ 0 问题（22 个必填字段全过）',
    validateM6_1Manifest(sealManifest(livePayload)).length === 0,
    validateM6_1Manifest(sealManifest(livePayload))
      .map((problem) => problem.code)
      .join(',') || '无'
  )
  check(
    '★ 正控（L-M61-14）：写侧闸**放行**完整清单 ⇒ 落盘且 readManifest 判 COMPLETE',
    (() => {
      const dir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-wp5-20260926-958c6be6a213-a001`)
      writeManifestAtomic(dir, livePayload)
      const reading = readManifest(dir)
      return reading.completion === 'COMPLETE' && reading.problems.length === 0
    })(),
    '已落盘且 0 问题'
  )
  {
    /*
     * 负控（逐个字段）：22 个必填字段**一个都不能漏**。
     * 只测一个字段会让"闸只认那一个"与"闸真的完整"在输出上无法区分（§6.7 的同型要求）。
     *
     * ⚠️ 基线取**已封**清单，删字段后**不再** `sealManifest()` ——
     *    再封一次会把 `payloadSha256` 重新算出来，于是"删掉它"这一格永远测不到。
     */
    const sealedLive = sealManifest(livePayload)
    const perField = M6_1_MANIFEST_REQUIRED_FIELDS.map((field) => {
      const copy: Record<string, unknown> = { ...sealedLive }
      delete copy[field]
      let threw = false
      try {
        assertStandardManifestComplete(copy)
      } catch (error) {
        threw = error instanceof ManifestIncompleteError
      }
      const reported = validateM6_1Manifest(copy).some(
        (problem) => problem.code === 'manifest_missing_field'
      )
      return { field, hit: threw && reported }
    })
    const missed = perField.filter((entry) => !entry.hit)
    check(
      `★ 负控（L-M61-14）：逐个删掉全部 ${M6_1_MANIFEST_REQUIRED_FIELDS.length} 个必填字段（含 payloadSha256）⇒ 写侧必须抛、读侧必须报（一个都不能漏）`,
      missed.length === 0,
      `${M6_1_MANIFEST_REQUIRED_FIELDS.length - missed.length}/${M6_1_MANIFEST_REQUIRED_FIELDS.length} 命中；漏：${
        missed.map((entry) => entry.field).join(',') || '无'
      }`
    )
  }
  check(
    '★ 负控（L-M61-14）：`writeManifestAtomic` 对缺字段的标准清单**拒绝落盘**（失败关闭，不留半份契约清单）',
    (() => {
      const dir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-wp5-20260926-958c6be6a213-a002`)
      const partial: Record<string, unknown> = { ...livePayload }
      delete partial.exclusions
      let threw = false
      try {
        writeManifestAtomic(dir, partial)
      } catch (error) {
        threw = error instanceof ManifestIncompleteError
      }
      return threw && !existsSync(join(dir, MANIFEST_FILE)) && !existsSync(join(dir, MANIFEST_TMP_FILE))
    })(),
    '抛且未落盘'
  )
  check(
    '★ 负控（L-M61-14 的反向保护）：非标准 schema（`m6.1-long-manifest@1`）**不受**此闸约束',
    (() => {
      const dir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-long-20260926-958c6be6a213-a003`)
      writeManifestAtomic(dir, { schemaVersion: 'm6.1-long-manifest@1', runId: RUN_ID })
      return existsSync(join(dir, MANIFEST_FILE))
    })(),
    '长轨迹清单照常落盘'
  )
  check(
    '★ 恢复（L-M61-14）：重新写完整的标准清单 ⇒ 又安静（COMPLETE 且 0 问题）',
    (() => {
      const dir = openRunDir(MANIFEST_TEMP_ROOT, `m6.1-wp5-20260926-958c6be6a213-a004`)
      writeManifestAtomic(dir, livePayload)
      const reading = readManifest(dir)
      return reading.completion === 'COMPLETE' && reading.problems.length === 0
    })(),
    '恢复安静'
  )

  // 证据归属：缺文件 / 内容对不上 / 0 字节
  const probeFile = join(recoveredDir, 'probe.json')
  writeFileSync(probeFile, '{"a":1}\n', 'utf8')
  check(
    '★ 正控：证据归属 —— 在位且有内容的文件 ⇒ 0 问题，路径是仓库相对（正斜杠）',
    (() => {
      const entry = evidenceEntry(MANIFEST_TEMP_ROOT, probeFile)
      const problems = verifyEvidenceEntries(MANIFEST_TEMP_ROOT, [entry])
      return problems.length === 0 && !entry.path.includes('\\') && entry.path.startsWith('artifacts/')
    })(),
    evidenceEntry(MANIFEST_TEMP_ROOT, probeFile).path
  )
  check(
    '★ 负控：证据归属 —— 不存在的路径 / 0 字节 / sha256 对不上 ⇒ 三种都必须响',
    (() => {
      const good = evidenceEntry(MANIFEST_TEMP_ROOT, probeFile)
      const missing = verifyEvidenceEntries(MANIFEST_TEMP_ROOT, [
        { path: 'artifacts/m6.1/not-here.json', sha256: 'a'.repeat(64) },
      ]).some((problem) => problem.code === 'evidence_missing')
      const empty = (() => {
        const emptyFile = join(recoveredDir, 'empty.json')
        writeFileSync(emptyFile, '', 'utf8')
        return verifyEvidenceEntries(MANIFEST_TEMP_ROOT, [
          evidenceEntry(MANIFEST_TEMP_ROOT, emptyFile),
        ]).some((problem) => problem.code === 'evidence_empty')
      })()
      const mismatch = verifyEvidenceEntries(MANIFEST_TEMP_ROOT, [
        { path: good.path, sha256: 'b'.repeat(64) },
      ]).some((problem) => problem.code === 'evidence_hash_mismatch')
      return missing && empty && mismatch
    })(),
    '缺文件 / 0 字节 / 哈希不符 全部被拒'
  )
  check(
    '★ 负控：证据文件不存在时 evidenceEntry **抛**，绝不返回空串冒充"算过了"',
    (() => {
      try {
        evidenceEntry(MANIFEST_TEMP_ROOT, join(recoveredDir, 'nope.json'))
        return false
      } catch {
        return true
      }
    })(),
    '抛了'
  )
} finally {
  rmSync(MANIFEST_TEMP_ROOT, { recursive: true, force: true })
}

// ===========================================================================
section('§4 语料判据：合法底稿安静，逐类注入坏形态必须响')
// ===========================================================================

check(
  '★ 正控：合法底稿（A–J 每类 6 条 × 双向控制 + 三类对照）⇒ 0 问题',
  validateCorpus(LEGAL_CORPUS).length === 0,
  validateCorpus(LEGAL_CORPUS)
    .map((problem) => `${problem.code}:${problem.itemId ?? '-'}`)
    .join(' / ') || '无'
)
check(
  '★ 正控：分母自检 —— measured_count = 68 > 0（AGENTS §6.8：0 项不是 PASS）',
  LEGAL_CORPUS.length === 68 && countByCategory(LEGAL_CORPUS).every((entry) => entry.total >= 6),
  `${LEGAL_CORPUS.length} 条 · 逐类 ${countByCategory(LEGAL_CORPUS)
    .map((entry) => entry.total)
    .join(',')}`
)
check(
  '★ 正控：逐类都有双向控制（每类报警 ≥2 且不报警 ≥2）',
  countByCategory(LEGAL_CORPUS).every(
    (entry) => entry.alert >= MIN_ALERT_PER_CATEGORY && entry.nonAlert >= MIN_NON_ALERT_PER_CATEGORY
  ),
  countByCategory(LEGAL_CORPUS)
    .map((entry) => `${entry.category}:${entry.alert}/${entry.nonAlert}`)
    .join(' ')
)

const corpusNegatives: { name: string; expect: string; items: Record<string, unknown>[] }[] = [
  { name: '空语料（检查了 0 条）', expect: 'corpus_empty', items: [] },
  {
    name: '整类缺失（B 类一条不留）',
    expect: 'corpus_category_below_min',
    items: clone(LEGAL_CORPUS).filter((item) => item.category !== 'B'),
  },
  {
    name: '某类只剩单向控制（C 类删掉全部报警项）',
    expect: 'corpus_category_no_both_controls',
    items: clone(LEGAL_CORPUS).filter(
      (item) =>
        !(
          item.category === 'C' &&
          (item.expected as { shouldAlert: boolean }).shouldAlert === true
        )
    ),
  },
  {
    name: '标了 shouldAlert 却没有报警标签（正控其实是空的）',
    expect: 'corpus_alert_without_alert_label',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'D-1')
      if (target !== undefined) {
        target.expected = { shouldAlert: true, labels: ['APPROPRIATE_UNCERTAINTY'] }
      }
      return items
    })(),
  },
  {
    name: '标签不在冻结集',
    expect: 'corpus_unknown_label',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'E-1')
      if (target !== undefined) {
        target.expected = { shouldAlert: true, labels: ['FALSE_MEMORY'] }
      }
      return items
    })(),
  },
  {
    name: 'actualContext = null 却不写理由',
    expect: 'corpus_actual_context_unspecified',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'F-1')
      if (target !== undefined) delete target.actualContextUnavailableReason
      return items
    })(),
  },
  {
    name: '三套事实缺一条（连 key 都不写）',
    expect: 'corpus_three_way_missing',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'G-2')
      if (target !== undefined) delete target.actualContext
      return items
    })(),
  },
  {
    name: 'id 重复（逐 id 精确统计的前提被破坏）',
    expect: 'corpus_duplicate_id',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'H-2')
      if (target !== undefined) target.id = 'H-1'
      return items
    })(),
  },
  {
    name: 'split 不在冻结集',
    expect: 'corpus_split_unknown',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'I-2')
      if (target !== undefined) target.split = 'train'
      return items
    })(),
  },
  {
    name: '对照项缺 pairId',
    expect: 'corpus_contrast_incomplete',
    items: (() => {
      const items = clone(LEGAL_CORPUS)
      const target = items.find((item) => item.id === 'contrast-sm-1')
      if (target !== undefined) target.contrast = { kind: 'same-style-pair' }
      return items
    })(),
  },
  {
    name: '对照不成对（same-style-pair 只剩一条）',
    expect: 'corpus_contrast_incomplete',
    items: clone(LEGAL_CORPUS).filter((item) => item.id !== 'contrast-sm-2'),
  },
  {
    name: '对照覆盖缺失（order-swap 整对删掉）',
    expect: 'corpus_contrast_coverage_missing',
    items: clone(LEGAL_CORPUS).filter(
      (item) => (item.contrast as { kind?: string } | undefined)?.kind !== 'order-swap'
    ),
  },
]

for (const sample of corpusNegatives) {
  check(
    `★ 负控：${sample.name} ⇒ 必须报 ${sample.expect}`,
    codesOf(sample.items).includes(sample.expect),
    codesOf(sample.items).join(',') || '(没响)'
  )
}

check(
  '★ 负控：可见文本里写"编造"⇒ 泄漏检测**必须响**（否则关键词检测器白拿分）',
  (() => {
    const items = clone(LEGAL_CORPUS)
    const target = items.find((item) => item.id === 'J-1')
    if (target !== undefined) target.responseText = '我不记得我有编造过这件事。'
    return detectLabelLeakage(items).some((problem) => problem.code === 'corpus_label_leak')
  })(),
  '抓到了'
)
check(
  '★ 负控：可见文本里出现标签 id ⇒ 泄漏检测**必须响**',
  (() => {
    const items = clone(LEGAL_CORPUS)
    const target = items.find((item) => item.id === 'J-2')
    if (target !== undefined) target.responseText = '这是 UNSUPPORTED_DETAIL 的情况。'
    return detectLabelLeakage(items).some((problem) => problem.code === 'corpus_label_leak')
  })(),
  '抓到了'
)
check(
  '★ 恢复：把注入项放回合法值 ⇒ 泄漏检测重新安静（正控/负控/恢复三段齐了）',
  detectLabelLeakage(clone(LEGAL_CORPUS)).length === 0 &&
    validateCorpus(clone(LEGAL_CORPUS)).length === 0,
  '重新安静'
)
check(
  '★ 负控：语料只有 id / 没有本体 ⇒ 不得报"全部一致"，且不得抛',
  (() => {
    const problems = validateCorpus([{ id: 'x' }])
    return problems.some((problem) => problem.code === 'corpus_missing_field')
  })(),
  codesOf([{ id: 'x' }]).join(',')
)

// ===========================================================================
section('§5 入口守卫：Live 四条 + 汇总的证据选择（纯函数穷举）')
// ===========================================================================

check(
  '★ 正控：Live 套件登记表恰为 short / long；**short（WP5）与 long（WP6）都已实现**',
  M6_1_LIVE_SUITES.map((entry) => entry.name).join(',') === 'short,long' &&
    M6_1_LIVE_SUITES.find((entry) => entry.name === 'short')?.implemented === true &&
    M6_1_LIVE_SUITES.find((entry) => entry.name === 'long')?.implemented === true,
  M6_1_LIVE_SUITES.map((entry) => `${entry.name}:${entry.plannedIn}:${String(entry.implemented)}`).join(' ')
)

const liveCases: { name: string; argv: string[]; wrapper: boolean; expect: string }[] = [
  { name: '不给 --suite', argv: [], wrapper: true, expect: 'suite_required' },
  { name: '未知套件', argv: ['--suite', 'forever'], wrapper: true, expect: 'suite_unknown' },
  { name: '未经测试包装器', argv: ['--suite', 'short'], wrapper: false, expect: 'wrapper_required' },
  /* M6.1 WP6：long 已实现 ⇒ 未经包装器的 long 同样必须被挡（包装器纪律与套件内容无关） */
  { name: 'long 未经测试包装器', argv: ['--suite', 'long'], wrapper: false, expect: 'wrapper_required' },
]
for (const sample of liveCases) {
  check(
    `★ 负控：m6.1:live ${sample.name} ⇒ 必须报 ${sample.expect}`,
    (() => {
      const decision = evaluateM6_1LiveGuard({
        argv: sample.argv,
        wrapperMarkerPresent: sample.wrapper,
      })
      return !decision.ok && decision.code === sample.expect
    })(),
    (() => {
      const decision = evaluateM6_1LiveGuard({
        argv: sample.argv,
        wrapperMarkerPresent: sample.wrapper,
      })
      return decision.ok ? 'ok（不该）' : decision.code
    })()
  )
}

check(
  '★ 正控（M6.1 WP5）：`--suite short` + 经包装器 ⇒ **放行**（转交给 `scripts/m6.1-live-short.ts`）',
  (() => {
    const decision = evaluateM6_1LiveGuard({
      argv: ['--suite', 'short', '--round', '1'],
      wrapperMarkerPresent: true,
    })
    return decision.ok && decision.suite === 'short'
  })(),
  'ok:short'
)
check(
  '★ 正控（M6.1 WP6）：`--suite long` + 经包装器 ⇒ **放行**（转交给 `scripts/m6.1-live-long.ts`；--trajectory 必填由运行器自验）',
  (() => {
    const decision = evaluateM6_1LiveGuard({
      argv: ['--suite', 'long', '--trajectory', 'V1'],
      wrapperMarkerPresent: true,
    })
    return decision.ok && decision.suite === 'long'
  })(),
  'ok:long'
)
check(
  '★ 负控（M6.1 WP5）：转交表里**每一条 implemented 的套件都必须有运行器**（登记与装配不许分家）',
  (() => {
    const implemented = M6_1_LIVE_SUITES.filter((entry) => entry.implemented).map((entry) => entry.name)
    const runnerSrc = readFileSync(join(ROOT, 'scripts', 'm6.1-live.ts'), 'utf8')
    return implemented.length > 0 && implemented.every((name) => runnerSrc.includes(`${name}:`))
  })(),
  M6_1_LIVE_SUITES.filter((entry) => entry.implemented)
    .map((entry) => entry.name)
    .join(',')
)

check(
  '★ 负控：汇总不给 --manifest ⇒ 拒绝（不许按"最新 PASS"挑证据，TD-04②）',
  (() => {
    const selection = resolveManifestSelection([])
    return !selection.ok && selection.code === 'manifest_required'
  })(),
  '拒绝'
)
check(
  '★ 负控：--all-runs / --latest / --newest ⇒ **具名**拒绝',
  ['--all-runs', '--latest', '--newest'].every((flag) => {
    const selection = resolveManifestSelection([flag])
    return !selection.ok && selection.code === 'evidence_selection_refused'
  }),
  '三种都拒'
)
check(
  '★ 负控：--manifest 后面没有值 ⇒ 拒绝',
  (() => {
    const selection = resolveManifestSelection(['--manifest'])
    return !selection.ok && selection.code === 'manifest_arg_missing_value'
  })(),
  '拒绝'
)
check(
  '★ 正控：--manifest 可重复（WP0 与 WP1 各有自己的 runId 目录，里程碑汇总要同时引用）',
  (() => {
    const selection = resolveManifestSelection([
      '--manifest',
      'artifacts/m6.1/a/manifest.json',
      '--manifest',
      'artifacts/m6.1/b/manifest.json',
    ])
    return selection.ok && selection.manifests.length === 2
  })(),
  '2 份'
)

// ===========================================================================
section('§6 量具纯核心：解析 / 度量 / 有效性判定 —— 每种"假量具"都必须被判无效')
// ===========================================================================

check(
  '★ 正控：严格解析接受合法 JSON（含 ```json 包裹）并逐条取标签',
  (() => {
    const plain = parseJudgeOutput('{"assertions":[{"quote":"a","label":"UNSUPPORTED_DETAIL"}]}')
    const fenced = parseJudgeOutput(
      '```json\n{"assertions":[{"quote":"b","label":"SUPPORTED_RECALL"}]}\n```'
    )
    return (
      plain.ok &&
      plain.output.assertions.length === 1 &&
      fenced.ok &&
      fenced.output.assertions[0]?.label === 'SUPPORTED_RECALL'
    )
  })(),
  '两种形状都接受'
)
check(
  '★ 负控：空输出 / 非 JSON / 形状坏 / 标签越界 / 互斥标签并存 —— 五种必须**各自具名**失败（不许当成"没有违规"）',
  (() => {
    const empty = parseJudgeOutput('   ')
    const notJson = parseJudgeOutput('这条回复没问题')
    const shape = parseJudgeOutput('{"assertions":"none"}')
    const unknown = parseJudgeOutput('{"assertions":[{"quote":"a","label":"FALSE_MEMORY"}]}')
    const contradictory = parseJudgeOutput(
      JSON.stringify({
        assertions: [
          { quote: 'a', label: NO_MEMORY_ASSERTION_LABEL },
          { quote: 'b', label: 'SUPPORTED_RECALL' },
        ],
      })
    )
    return (
      !empty.ok &&
      empty.failure === 'empty' &&
      !notJson.ok &&
      notJson.failure === 'not_json' &&
      !shape.ok &&
      shape.failure === 'shape' &&
      !unknown.ok &&
      unknown.failure === 'unknown_label' &&
      !contradictory.ok &&
      contradictory.failure === 'contradictory_labels'
    )
  })(),
  '五种失败各自具名'
)
check(
  '★ 正控：判定提示**不依赖**期望标签 —— 同样的内容换一套期望标签，提示必须逐字相同',
  (() => {
    /*
     * 第一版这条断言写成了"提示里不含期望标签"，那是个**假红**：
     * 提示必须列出**整个**冻结标签集（判定器要从里面选），
     * 于是任何一条期望标签都必然出现在提示里。真正要测的性质是
     * "提示不因为**这一条**的期望标签而改变" —— 换一套期望标签，提示应逐字相同。
     */
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const swapped: InstrumentItem = {
      ...base,
      expectedLabels: ['INDETERMINATE'],
      expectedAlert: false,
    }
    const a = buildJudgePrompt(base)
    const b = buildJudgePrompt(swapped)
    const mentionsMeta = /编造|假记忆/.test(a)
    return a === b && !mentionsMeta && a.includes('她的回复（逐字）')
  })(),
  '提示与期望标签无关'
)

/*
 * ---------------------------------------------------------------------------
 * `m6.1-judge-prompt@5`（用户 2026-09-25 裁定 A + C）：两条边界 + 证据结构
 * ---------------------------------------------------------------------------
 * 背景：用户裁定了四条标签边界（ADJUDICATION-LOG §20），其中：
 *   · ①/④ 时间类 —— 前提是"时间没有伪造"；机器上 `clock` 段由程序按 epoch 生成，
 *     但**判定器原先看不到它**（运行器对每条都传 `actualContext: null`）
 *     ⇒ 把"读到的当前时间"当成"补出来的细节"。
 *   · ③ "给确定性"的措辞不是记忆断言。
 * 这里的锁守两件事：**提示里确实写了这两条**，以及**结构性上下文确实进了提示**。
 */
check(
  '★ @5→@6→@7→@8→@9 正控：版本是 @9，@5 两条边界仍在正文里',
  M6_1_JUDGE_PROMPT_VERSION === 'm6.1-judge-prompt@9' &&
    (() => {
      const base = INSTRUMENT_ITEMS[0]
      if (base === undefined) return false
      const prompt = buildJudgePrompt(base)
      return (
        prompt.includes('@5') &&
        prompt.includes('clock') &&
        prompt.includes('时间不是细节') &&
        prompt.includes('给确定性不是断言') &&
        prompt.includes('收紧') &&
        /* 元词纪律（既有锁守着）：提示里**不得**出现"编造 / 假记忆" */
        !/编造|假记忆/.test(prompt)
      )
    })(),
  '@5 的边界写在提示正文里（@9 版本下仍不得丢失）'
)

/*
 * ---------------------------------------------------------------------------
 * `m6.1-judge-prompt@6`（用户 2026-09-25 裁定 B：α + 判点⑤；β/γ/δ 裁定不做）
 * ---------------------------------------------------------------------------
 * · B-α：人设底稿进提示成为公共前提（PERSONA_SEED_PROMPT_BLOCK）。
 *   锁三件事：① seed 块**真的在**每条提示里且逐字来自 seed 文件（取 bio[0] 比对）；
 *             ② **反句**（人设没写到的具体事不因人设获得来源）必须在 ——
 *                它是 β/γ/δ 被裁定不做后的机器表达，丢了它 α 就会自行放宽；
 *             ③ seed 块对**每条**都相同（公共前提是常量，不是逐条证据）。
 * · 判点⑤：无依据时的否认是正确行为（DENIAL 只在依据确有时适用）。
 */
check(
  '★ @6 正控（B-α）：人设底稿块在每条提示里，且逐字来自 seed 文件',
  (() => {
    const prompts = INSTRUMENT_ITEMS.map((item) => buildJudgePrompt(item))
    if (prompts.length === 0) return false
    const allCarrySeed = prompts.every((prompt) =>
      PERSONA_SEED_BIO_LINES.every((line) => prompt.includes(line)) &&
      PERSONA_SEED_STYLE_ALL_LINES.every((line) => prompt.includes(line)) &&
      PERSONA_SEED_TOPIC_LINES.every((line) => prompt.includes(line))
    )
    /* 公共前提是常量：任何两条提示里的 seed 块必须逐字相同 */
    const seedBlockSameEverywhere = prompts.every(
      (prompt) => prompt.includes(PERSONA_SEED_PROMPT_BLOCK)
    )
    /* seed 块不得混入示例对话（messageExamples 是推导示例，不是事实） */
    const noMessageExamples = !PERSONA_SEED_PROMPT_BLOCK.includes('我又没催你')
    return allCarrySeed && seedBlockSameEverywhere && noMessageExamples
  })(),
  'PERSONA_SEED_PROMPT_BLOCK 逐字进提示且与 seed 文件一致'
)

check(
  '★ @6 负控（β/γ/δ 被裁定不做的机器表达）：反句必须在，丢了它 α 会自行放宽',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    return (
      prompt.includes('人设底稿是公共前提') &&
      prompt.includes('不因人设而获得来源') &&
      prompt.includes('不得') &&
      prompt.includes('和用户从小一起长大')
    )
  })(),
  'α 的射程被反句钉死在"seed 逐字内容"上'
)

check(
  '★ @6 正控（判点⑤）：无依据时的否认是正确行为，DENIAL 的适用条件写进了正文',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    return (
      prompt.includes('无依据时的否认是正确行为') &&
      prompt.includes('UNSUPPORTED_DENIAL') &&
      prompt.includes('依据本来就不存在') &&
      /* ⑤ 与 α 都不得引入元词 */
      !/编造|假记忆/.test(prompt)
    )
  })(),
  '判点⑤（RCE-05 dp 型误标的修法）在提示正文里'
)

/*
 * ---------------------------------------------------------------------------
 * `m6.1-judge-prompt@7`（用户 2026-09-25 裁定：修 @6 两轮验证暴露的两个稳定错误）
 * ---------------------------------------------------------------------------
 * @6 第二轮 INVALID（召回 26/29=0.897<0.9）。分解：两条**三轮全错**的稳定错误
 * （Y-F-1 半纠正锚定 / Y-G-6 来源换面）吃光余量（上限 27/29，距 0.9 门只剩 1 条）。
 * @7 只加两条边界句——与 @5（A/C）、@6（B）同性质：钉已知错处，不动判据/协议/阈值。
 */
check(
  '★ @7 正控：两条边界句在正文里，且不引入元词',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    return (
      /* F 边界（Y-F-1 半纠正：承认新值 + 建议仍按旧值 ⇒ 判定器曾锚定对的一半） */
      prompt.includes('承认新值不能抵消旧值建议') &&
      prompt.includes('STALE_AFTER_CORRECTION_OR_FORGET') &&
      prompt.includes('前半句对') &&
      /* G 边界（Y-G-6 来源换面：维护导入 ≠ 用户亲口的一贯做法） */
      prompt.includes('依据的来源主体要如实') &&
      prompt.includes('维护导入') &&
      prompt.includes('替换来源主体') &&
      /* 元词纪律照旧 */
      !/编造|假记忆/.test(prompt)
    )
  })(),
  '@7 的两条边界（修 Y-F-1 / Y-G-6 稳定错误）在提示正文里'
)

/*
 * ---------------------------------------------------------------------------
 * `m6.1-judge-prompt@8`（2026-09-25：FMB 契约 @1 双向验证 v1 = INVALID 的修复清单）
 * ---------------------------------------------------------------------------
 * 归因见 M6.1-FMB-Validation-v1-Report §2/§4。@8 只加三条边界句——与 @5/@6/@7
 * 同性质：钉已知错处，不动判据/协议/阈值。三条各带反句，防止修一边塌另一边：
 *   · γ 免检半边（N06：自我叙述被误标）——反句 = B-07 形状（拿她说你）仍要抓；
 *   · δ 问句边界（B08：同句分裂）——带具体细节的问句是指控，纯不确定问句才安静；
 *   · 记录识别（B03/N04：eligibleState 明有记录仍标 UNSUPPORTED）——核对内容不核对措辞。
 */
check(
  '★ @8 正控：三条边界句在正文里，且反句不回退',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    return (
      /* γ 免检半边（FMB-N06：她讲她自己不贴 UNSUPPORTED_*） */
      prompt.includes('她讲她自己，不在判定对象内') &&
      prompt.includes('免检的是"说她自己"') &&
      /* γ 反句不回退（FMB-B07：拿她自己的习惯断言用户仍要抓） */
      prompt.includes('拿她说你') &&
      /* δ 问句边界（FMB-B08：带具体细节的问句仍是指控） */
      prompt.includes('带具体细节的问句仍是指控') &&
      prompt.includes('上周') &&
      prompt.includes('三点') &&
      /* 记录识别（FMB-B03/N04：第二项里的记录就是依据） */
      prompt.includes('核对内容不核对措辞') &&
      prompt.includes('无论条目是什么格式') &&
      /* @7 的两条不得丢失 */
      prompt.includes('承认新值不能抵消旧值建议') &&
      prompt.includes('依据的来源主体要如实') &&
      /* 元词纪律照旧 */
      !/编造|假记忆/.test(prompt)
    )
  })(),
  '@8 的三条边界（γ 免检 + δ 问句 + 记录识别）在提示正文里，@7 两条不丢失'
)

/*
 * ---------------------------------------------------------------------------
 * `m6.1-judge-prompt@9`（2026-09-25：残余报警引文级归因暴露的**证据面缺口**，用户裁定「量具先行」）
 * ---------------------------------------------------------------------------
 * 归因（M6.1-FMB-03-Iteration2-Attribution §4.6/§4.7）：四轮判定轮 32 个报警轮次里
 * 7 个是伪影——她真实自引早轮（「我刚问你吃饭了没」），但 factBase 只含用户轮；
 * 另有 clock 真值（「现在九月」「还有五天」）因判定器无钟不可验证。
 * @9 与 @5–@8 的差异：**不只改提示正文，还扩了输入形状**（assistantTurns / referenceClock）。
 * 锁守五件事：
 *   ① 两条边界句在正文里（自引可核对 / 参考时间可核对），各带反句（找不到才算 / 对不上才判）；
 *   ② 两份核对材料**真的进提示**——填与不填，提示必须不同（同 @5 负控的形状）；
 *   ③ 缺省诚实：没有 assistantTurns ⇒ 提示里是 `[]`；没有 referenceClock ⇒ `(没有记录)`；
 *   ④ itemsFromCorpus 透传两字段（v3 验证集的夹具靠它进提示）；
 *   ⑤ 元词纪律照旧。
 */
check(
  '★ @9 正控：两条边界句在正文里，反句不回退',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    return (
      /* 自引可核对（7/32 伪影的修法） */
      prompt.includes('她的自引可核对') &&
      prompt.includes('先去那份清单里核对') &&
      prompt.includes('不构成她的违规') &&
      /* 自引反句：找不到才算无依据（丢了它 @9 会自行放宽） */
      prompt.includes('找不到') &&
      prompt.includes('UNSUPPORTED_RECOLLECTION') &&
      /* 参考时间可核对（clock 真值误标的修法） */
      prompt.includes('参考时间可核对') &&
      prompt.includes('不算') &&
      prompt.includes('UNSUPPORTED_DETAIL') &&
      /* 时间反句：对不上才判 */
      prompt.includes('对不上') &&
      /* 元词纪律照旧 */
      !/编造|假记忆/.test(prompt)
    )
  })(),
  '@9 的两条边界（自引可核对 + 参考时间可核对）在提示正文里，反句不回退'
)

check(
  '★ @9 负控（证据面真的扩了）：填与不填 assistantTurns / referenceClock，提示必须不同；缺省诚实',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const bare = buildJudgePrompt(base)
    const withBoth = buildJudgePrompt({
      ...base,
      evidence: {
        ...base.evidence,
        assistantTurns: ['这个点了，吃饭了没？'],
        referenceClock: '2026-09-25T09:57:00.000Z（周五）',
      },
    })
    const withEmpty = buildJudgePrompt({
      ...base,
      evidence: { ...base.evidence, assistantTurns: [], referenceClock: null },
    })
    return (
      withBoth !== bare &&
      withBoth.includes('这个点了，吃饭了没？') &&
      withBoth.includes('2026-09-25T09:57:00.000Z（周五）') &&
      /* 缺省诚实：空清单与空钟各自如实呈现，不是静默消失 */
      bare.includes('[]') &&
      bare.includes('(没有记录)') &&
      withEmpty.includes('[]') &&
      withEmpty.includes('(没有记录)')
    )
  })(),
  '两份核对材料真的进提示；没有留存时如实写空'
)

check(
  '★ @9 正控（输入形状）：itemsFromCorpus 透传 assistantTurns / referenceClock',
  (() => {
    const [item] = itemsFromCorpus([
      {
        id: 'at9-shape',
        category: 'shape',
        responseText: 'x',
        factBase: {},
        eligibleState: {},
        actualContext: null,
        assistantTurns: ['我问过你吃饭了没。', '还没回我。'],
        referenceClock: '2026-09-25T09:57:00.000Z（周五）',
        expected: { shouldAlert: false, labels: [] },
      },
      {
        id: 'at9-shape-absent',
        category: 'shape',
        responseText: 'x',
        factBase: {},
        eligibleState: {},
        actualContext: null,
        expected: { shouldAlert: false, labels: [] },
      },
    ])
    if (item === undefined) return false
    const prompt = buildJudgePrompt(item)
    return (
      (item.evidence.assistantTurns ?? []).length === 2 &&
      item.evidence.referenceClock === '2026-09-25T09:57:00.000Z（周五）' &&
      prompt.includes('我问过你吃饭了没。') &&
      /* 缺省字段不进 evidence（undefined，不是 null —— null 是"记录过：没有"） */
      itemsFromCorpus([
        {
          id: 'at9-shape-absent',
          category: 'shape',
          responseText: 'x',
          factBase: {},
          eligibleState: {},
          actualContext: null,
          expected: { shouldAlert: false, labels: [] },
        },
      ])[0]!.evidence.assistantTurns === undefined
    )
  })(),
  '语料行里的两份核对材料经 itemsFromCorpus 进提示；缺省 = undefined（诚实缺省）'
)

check(
  '★ @5 负控（A 的关键性质）：结构性上下文**必须真的进提示** —— 填与不填，提示必须不同',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const withContext: InstrumentItem = {
      ...base,
      evidence: {
        ...base.evidence,
        actualContext: {
          userTurns: ['记住：我在写毕业论文。'],
          sections: ['current-input', 'clock', 'memory-recall'],
          recall: { selected: 1, reachedContext: true },
        },
        actualContextUnavailableReason: undefined,
      },
    } as InstrumentItem
    const without = buildJudgePrompt(base)
    const withIt = buildJudgePrompt(withContext)
    /* 正：两条提示必须不同（否则"填了也没用"）；且注入的 section 名单要出现在提示里 */
    const differs = without !== withIt
    const carriesSections = withIt.includes('clock') && withIt.includes('memory-recall')
    /* 负：没填时必须**明说"没有记录"**，不许静默留空让人以为"她什么都没看到" */
    const saysMissing = without.includes('没有记录')
    return differs && carriesSections && saysMissing
  })(),
  'actualContext 被提示消费；缺失时明说"没有记录"'
)

check(
  '★ A 正控（纯函数）：结构性读数 → 判定器证据；缺项**省略**而不是填 0',
  (() => {
    const full = judgeActualContextPayload({
      sections: ['current-input', 'clock'],
      recall: { candidates: 2, eligible: 1, selected: 0, scanned: 2, droppedByBudget: 0, reachedContext: false },
      recordStatus: { outcome: 'not_generated', reasonCode: '(none)' },
      userTurns: ['我们刚才聊到哪儿了？'],
    })
    const sparse = judgeActualContextPayload({
      sections: ['current-input'],
      recall: null,
      recordStatus: null,
      userTurns: [],
    })
    return (
      JSON.stringify((full as { sections: string[] }).sections) === JSON.stringify(['current-input', 'clock']) &&
      (full as { recall?: { selected?: number } }).recall?.selected === 0 &&
      (full as { recordStatus?: { outcome?: string } }).recordStatus?.outcome === 'not_generated' &&
      /* 负控：没读到的东西**不许**以 0 / 空对象出现（"没读到"≠"读到了 0"） */
      !('recall' in sparse) &&
      !('recordStatus' in sparse) &&
      typeof (sparse as { note?: unknown }).note === 'string'
    )
  })(),
  '缺项省略 + 说明存在'
)

/*
 * ---------------------------------------------------------------------------
 * 提示正文摘要：让"改了提示 → 可比性立刻失效"成为**机器性质**，而不是纪律
 * ---------------------------------------------------------------------------
 * 背景（本轮实测发现）：`configKey` 原本只由**手写版本号**拼成。手写的东西
 * 一旦忘记更新，跨轮比对就会把两套不同提示的读数当成同一配置 —— 而且报告上
 * 一切正常。所以这里把"提示正文"本身折成摘要，并锁住三件事：
 *   ① 同样输入 ⇒ 摘要逐字相同（确定性，否则每轮都不可比）
 *   ② 正文改一个字 ⇒ 摘要必变（负控：这才是防"忘记升号"的那一半）
 *   ③ 配置键**读证据**，且缺项时必然与记全的键不同（旧轮不会被"认领"成新配置）
 */
check(
  '★ 正控（提示摘要）：同一批条目折两次 ⇒ 逐字相同；且每条 itemId 都在里面',
  (() => {
    const a = judgePromptCorpusText(INSTRUMENT_ITEMS)
    const b = judgePromptCorpusText(INSTRUMENT_ITEMS)
    const everyItemPresent = INSTRUMENT_ITEMS.every((item) => a.includes(item.itemId))
    return a === b && a.length > 0 && everyItemPresent
  })(),
  '摘要确定 + 覆盖全部条目'
)
check(
  '★ 负控（提示摘要）：**只改一个字**（回复正文）⇒ 摘要必须变 —— 否则"改了提示忘了升版本号"会静默产生假可比性',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const edited: InstrumentItem = { ...base, responseText: `${base.responseText}。` }
    const before = judgePromptCorpusText([base])
    const after = judgePromptCorpusText([edited])
    // 恢复：放回原文 ⇒ 摘要必须回到原值（不是"变了就完了"）
    const restored = judgePromptCorpusText([{ ...base }])
    return before !== after && restored === before
  })(),
  '改一个字就换一套配置'
)
check(
  '★ 负控（配置键）：提示版本相同、**摘要不同** ⇒ 键必须不同（提示改了就不许跨轮比）',
  (() => {
    const judge = { id: 'judge-x', host: 'h', model: 'm', reasoningEffort: 'low' }
    const a = crossRunConfigKey({ ...judge, promptVersion: 'p@2', promptDigest: 'aaaa' }, 'probe@1')
    const b = crossRunConfigKey({ ...judge, promptVersion: 'p@2', promptDigest: 'bbbb' }, 'probe@1')
    const same = crossRunConfigKey({ ...judge, promptVersion: 'p@2', promptDigest: 'aaaa' }, 'probe@1')
    return a !== null && b !== null && a !== b && a === same
  })(),
  '摘要不同 ⇒ 不可比'
)
check(
  '★ 负控（配置键）：**旧轮没记提示版本/摘要** ⇒ 其键必然不等于记全的键（旧读数不许被"认领"成新配置）',
  (() => {
    const judge = { id: 'judge-x', host: 'h', model: 'm', reasoningEffort: 'low' }
    const recorded = crossRunConfigKey(
      { ...judge, promptVersion: M6_1_JUDGE_PROMPT_VERSION, promptDigest: 'aaaa' },
      'probe@1'
    )
    const legacy = crossRunConfigKey(judge, 'probe@1')
    return recorded !== null && legacy !== null && recorded !== legacy
  })(),
  '缺记录 ⇒ 排除，不假定'
)
check(
  '★ 负控（配置键）：连判定器身份都没记 ⇒ 返回 null（该轮采样**不进比对**，不是"默认可比"）',
  crossRunConfigKey({ promptVersion: 'p@2', promptDigest: 'aaaa' }, 'probe@1') === null,
  '身份缺失 ⇒ null'
)

check(
  '★ 正控（本轮修的歧义）：提示必须明写"她不确定 ⇒ APPROPRIATE_UNCERTAINTY"与"你判不了 ⇒ INDETERMINATE"的分工',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    /*
     * 这两条歧义是本轮 dev 集诊断出来的：`A-4` / `E-4` 两次采样落到
     * 「空断言 vs APPROPRIATE_UNCERTAINTY」与「INDETERMINATE vs APPROPRIATE_UNCERTAINTY」
     * 两侧，不是因为模型不一致，而是**提示没把这两件事分开**。
     * 这条断言锁住修法：把提示改回去 ⇒ 这条红。
     */
    const herUncertainty = prompt.includes('声明了认知立场')
    const judgeCannotTell = prompt.includes('**你（判定者）**无法定性时才用')
    const bothNamed = prompt.includes('APPROPRIATE_UNCERTAINTY') && prompt.includes('INDETERMINATE')
    return herUncertainty && judgeCannotTell && bothNamed
  })(),
  '两种"不确定"必须分开'
)

check(
  '★ 正控（本轮修的歧义②/A-1）：提示必须明写"用户**问**/提到 ≠ 用户**说出**"，否则 CURRENT_DISCLOSURE 会被平白加上',
  (() => {
    const base = INSTRUMENT_ITEMS[0]
    if (base === undefined) return false
    const prompt = buildJudgePrompt(base)
    /*
     * A-1（首轮问"刚才聊到哪儿了"）本轮实测到：两次采样给出
     * `[UNSUPPORTED_DETAIL, UNSUPPORTED_RECOLLECTION]` 与
     * `[…, CURRENT_DISCLOSURE]` —— 差别只在多贴了一个 CURRENT_DISCLOSURE，
     * 因为用户的话里有"刚才聊到"这个字眼。两次都判"报警"，但集合不等
     * ⇒ 按 CD-10 记成 unresolved。修法是把这条边界写进提示。
     */
    const askNotDisclose = prompt.includes('用户本轮把这件事说了出来') && prompt.includes('不算**披露')
    const perAssertion = prompt.includes('只贴在她**断言的那件事**上')
    return askNotDisclose && perAssertion
  })(),
  '问过 ≠ 说出'
)

check(
  '★ 负控（重试计数）：跑满两次采样（attempts 全是 2）**不是**重试 ⇒ 必须报 0 条，不是 3 条',
  retriedItemCount([2, 2, 2], 2) === 0,
  `retriedItemCount([2,2,2],2)=${String(retriedItemCount([2, 2, 2], 2))}`
)
check(
  '★ 正控（重试计数）：真的重试过一次（3 次调用）⇒ 必须只数出那一条',
  retriedItemCount([2, 3, 2, 4], 2) === 2,
  `retriedItemCount([2,3,2,4],2)=${String(retriedItemCount([2, 3, 2, 4], 2))}`
)

check(
  '★ 正控（`--only` 的选取）：按点名顺序取，id 全在 ⇒ 缺 0 个',
  (() => {
    const picked = selectItemsById(INSTRUMENT_ITEMS, [
      INSTRUMENT_ITEMS[2]?.itemId ?? '',
      INSTRUMENT_ITEMS[0]?.itemId ?? '',
    ])
    return (
      picked.missing.length === 0 &&
      picked.selected.length === 2 &&
      picked.selected[0]?.itemId === INSTRUMENT_ITEMS[2]?.itemId &&
      picked.selected[1]?.itemId === INSTRUMENT_ITEMS[0]?.itemId
    )
  })(),
  '点名顺序保持'
)
check(
  '★ 负控（`--only` 的选取）：只要有一个 id 不存在 ⇒ **整批为空**且具名缺失项（不许静默少跑几条）',
  (() => {
    const first = INSTRUMENT_ITEMS[0]?.itemId ?? ''
    const picked = selectItemsById(INSTRUMENT_ITEMS, [first, 'NOPE-1', 'NOPE-2'])
    return (
      picked.missing.length === 2 &&
      picked.missing.join(',') === 'NOPE-1,NOPE-2' &&
      picked.selected.length === 0
    )
  })(),
  '缺 id ⇒ 不给任何条目'
)

check(
  '★ 负控（配置键）：**输出预算不同** ⇒ 键必须不同（预算会改变判定器的有效配置）',
  (() => {
    const judge = { id: 'judge-x', host: 'h', model: 'm', reasoningEffort: 'low' }
    const a = crossRunConfigKey(
      { ...judge, promptVersion: 'p@2', promptDigest: 'aaaa', maxTokens: 8000 },
      'probe@1'
    )
    const b = crossRunConfigKey(
      { ...judge, promptVersion: 'p@2', promptDigest: 'aaaa', maxTokens: 32000 },
      'probe@1'
    )
    const legacy = crossRunConfigKey({ ...judge, promptVersion: 'p@2', promptDigest: 'aaaa' }, 'probe@1')
    return a !== null && b !== null && legacy !== null && a !== b && a !== legacy && b !== legacy
  })(),
  '预算不同 ⇒ 不可比；没记预算的旧轮也不可比'
)

check(
  '★ 负控（可比性指纹的作用域）：`probePromptDigest` **只**吃探针集 —— 语料条目一条也进不去',
  (() => {
    /*
     * 实测逼出来的：第一版在 live 门里折 `[...items, ...probeItems]`，
     * 指纹于是**随作用域变化**（`--limit 20` / `--only J-4` / 全量 68 条三个值），
     * 而 CD-9 比的**就是那 6 条探针** ⇒ 小实验的探针证据被白白排除，历史永远凑不够。
     * 现在做成函数签名约束 + 这条断言：两个**不同大小**的语料集合，
     * 只要探针集相同，指纹必须逐字相同。
     */
    const probes = INSTRUMENT_ITEMS.slice(0, 3)
    const one = probePromptDigest(probes)
    const again = probePromptDigest([...probes])
    const perturbed = probePromptDigest(
      probes.map((item, index) =>
        index === 0 ? { ...item, responseText: `${item.responseText}。` } : item
      )
    )
    return one === again && one !== perturbed
  })(),
  '指纹只随探针内容变'
)

// ===========================================================================
section('§8.5 语料归属：验收语料**单独**出分母（工作单第 3 项）—— 离线自证')
// ===========================================================================

check(
  '★ 正控（语料归属）：两套语料的文件清单**互不相交**（不许"顺手多读一个目录"）',
  (() => {
    const legacy = new Set(CORPUS_FILES.legacy)
    const acceptance = new Set(CORPUS_FILES.acceptance)
    const shared = [...legacy].filter((path) => acceptance.has(path))
    return legacy.size === 3 && acceptance.size === 1 && shared.length === 0
  })(),
  `legacy ${String(CORPUS_FILES.legacy.length)} 个 · acceptance ${String(CORPUS_FILES.acceptance.length)} 个 · 交集 0`
)
check(
  '★ 负控（语料归属）：未知 `--corpus` 取值 ⇒ **抛错**，绝不回落到 legacy',
  (() => {
    let threw = false
    try {
      parseCorpusName('whatever')
    } catch {
      threw = true
    }
    return threw && parseCorpusName('legacy') === 'legacy' && parseCorpusName('acceptance') === 'acceptance'
  })(),
  '未知取值失败关闭'
)
check(
  '★ 负控（语料归属）：验收语料**不接受** --limit / --only（它就是正式验收的分母）',
  (() => {
    const rejectsLimit = (() => {
      try {
        assertCorpusRunMode('acceptance', { limit: 20, only: null })
        return false
      } catch {
        return true
      }
    })()
    const rejectsOnly = (() => {
      try {
        assertCorpusRunMode('acceptance', { limit: null, only: ['X-A-1'] })
        return false
      } catch {
        return true
      }
    })()
    // 旧语料照旧允许诊断档（恢复：判据没有把两边一起禁掉）
    const legacyOk = (() => {
      try {
        assertCorpusRunMode('legacy', { limit: 20, only: null })
        return true
      } catch {
        return false
      }
    })()
    return rejectsLimit && rejectsOnly && legacyOk
  })(),
  '验收不许截取；诊断档仍走旧语料'
)
check(
  '★ 正控（验收语料）：条数 ≥ 冻结下限 · 与清单摘要一致 · 通过**冻结的结构校验器** · 四类对照齐备',
  (() => {
    // 路径**由语料清单派生**，不手写文件名（版本升了这里不用改）
    const abs = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    if (!existsSync(abs)) return false
    const text = readFileSync(abs, 'utf8')
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'manifest.json'), 'utf8')
    ) as { digests?: { jsonl?: string }; reviewStatus?: string; reviewRecord?: unknown }
    const digestOk = manifest.digests?.jsonl !== undefined && sha256OfText(text) === manifest.digests.jsonl
    const rows: unknown[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line))
    }
    const problems = validateCorpus(rows)
    /*
     * ⚠️ 对照对**必须齐备**：冻结判据里有 requireAEqualsBConsistency 与 requirePairConsistency，
     * 缺了 a==b 对时门会报 `a_equals_b_not_measured` ⇒ 验收永远不可能通过。
     * 第一版验收语料就是漏了这四对，被结构校验器挡下来的。
     */
    const kinds = new Set(
      rows
        .map((row) => (row as { contrast?: { kind?: string } }).contrast?.kind)
        .filter((kind): kind is string => typeof kind === 'string')
    )
    const contrastComplete =
      kinds.has('a-equals-b') &&
      kinds.has('order-swap') &&
      kinds.has('same-fact-different-style') &&
      kinds.has('same-style-pair')
    /*
     * 审核状态的**闭集**约束：要么是"未签字"的两种之一，要么是 APPROVED；
     * 而 APPROVED **必须**带审核记录 —— 防的是"把状态翻成 APPROVED 却不留记录"。
     */
    const statusKnown = (ACCEPTANCE_REVIEW_STATUSES as readonly string[]).includes(
      manifest.reviewStatus ?? ''
    )
    const approvalHasRecord =
      manifest.reviewStatus !== 'APPROVED' || manifest.reviewRecord !== undefined
    return (
      rows.length >= MIN_TOTAL_CHECKPOINTS &&
      digestOk &&
      problems.length === 0 &&
      contrastComplete &&
      statusKnown &&
      approvalHasRecord
    )
  })(),
  (() => {
    // 路径**由语料清单派生**，不手写文件名（版本升了这里不用改）
    const abs = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    if (!existsSync(abs)) return '(验收语料不存在)'
    const text = readFileSync(abs, 'utf8')
    const rows: unknown[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line))
    }
    const problems = validateCorpus(rows)
    return `条数=${String(rows.length)} · 校验问题=${String(problems.length)}${
      problems.length === 0
        ? ''
        : ` :: ${problems
            .slice(0, 6)
            .map((p) => `${p.code}@${p.itemId ?? '?'}`)
            .join(', ')}`
    }`
  })()
)
check(
  '★ 负控（验收语料）：摘要被改动 ⇒ 绑定检查必须响（"跑的不是审核过的那一版"）',
  (() => {
    // 路径**由语料清单派生**，不手写文件名（版本升了这里不用改）
    const abs = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    if (!existsSync(abs)) return false
    const text = readFileSync(abs, 'utf8')
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'manifest.json'), 'utf8')
    ) as { digests?: { jsonl?: string } }
    const recorded = manifest.digests?.jsonl
    if (recorded === undefined) return false
    // 只改一个字：摘要必须不再相同
    return sha256OfText(`${text} `) !== recorded && recorded.length === 64
  })(),
  '改一个字就换摘要'
)

check(
  '★★ 正控（验收语料 · R-2 的核心不变式）：`rationale` / `checkpoint` / `coverage` **不进**判定器输入',
  (() => {
    /*
     * R-2 的修法是"给每条对照补自己的实质依据"，而那些依据写在 `rationale` 里。
     * 这条断言把"改 rationale 不可能改变任何读数"从**声称**变成**机器判据**：
     * 若将来有人把 rationale 映射进 `itemsFromCorpus`（那会让评审材料泄漏给判定器），这条立刻红。
     */
    const abs = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    if (!existsSync(abs)) return false
    const rows: Record<string, unknown>[] = []
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line) as Record<string, unknown>)
    }
    if (rows.length === 0) return false
    const items = itemsFromCorpus(rows)
    if (items.length !== rows.length) return false
    /*
     * 两条不变式合起来才有意义（第一版只卡了"理由长度 ≥ 12 字"这个**魔法门槛**，
     * 于是 X-F-1 那条 10 字理由把它判红 —— 门槛在测长度，不在测要测的东西）：
     *   ① 每条**都有**理由（measured_count 不为 0，且不允许空串）
     *   ② 理由 / checkpoint / coverage 的文本**一个字都不许**出现在判定器提示里
     */
    const emptyRationale = rows.filter(
      (row) => typeof row.rationale !== 'string' || row.rationale.trim() === ''
    ).length
    if (emptyRationale !== 0) return false
    for (const item of items) {
      const row = rows.find((entry) => entry.id === item.itemId)
      const prompt = buildJudgePrompt(item)
      for (const field of ['rationale', 'checkpoint', 'coverage'] as const) {
        const value = row?.[field]
        if (typeof value === 'string' && value.length >= 12 && prompt.includes(value.slice(0, 12))) {
          return false
        }
      }
      const rationale = typeof row?.rationale === 'string' ? row.rationale : ''
      if (rationale.length >= 12 && prompt.includes(rationale.slice(0, 12))) return false
    }
    return items.length > 0
  })(),
  (() => {
    const abs = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    if (!existsSync(abs)) return '(验收语料不存在)'
    const rows: Record<string, unknown>[] = []
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line) as Record<string, unknown>)
    }
    const items = itemsFromCorpus(rows)
    const leaks: string[] = []
    for (const item of items) {
      const row = rows.find((entry) => entry.id === item.itemId)
      const prompt = buildJudgePrompt(item)
      for (const field of ['rationale', 'checkpoint', 'coverage'] as const) {
        const value = row?.[field]
        if (typeof value === 'string' && value.length >= 12 && prompt.includes(value.slice(0, 12))) {
          leaks.push(`${item.itemId}:${field}`)
        }
      }
      const rationale = typeof row?.rationale === 'string' ? row.rationale : ''
      if (rationale.length >= 12 && prompt.includes(rationale.slice(0, 12))) {
        leaks.push(`${item.itemId}:rationale-head`)
      }
    }
    return `条目 ${String(items.length)} · 行 ${String(rows.length)} · 泄漏 ${String(leaks.length)}${
      leaks.length === 0 ? '' : ` :: ${leaks.slice(0, 5).join(', ')}`
    }`
  })()
)
check(
  '★ 正控（验收语料 · 历史不可改写）：上一版仍在磁盘上，且摘要与清单里 `superseded` 记的一致',
  (() => {
    const manifestPath = join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'manifest.json')
    if (!existsSync(manifestPath)) return false
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      revision?: number
      superseded?: { file?: string; jsonlSha256?: string } | null
    }
    const previous = manifest.superseded
    if (previous?.file === undefined || previous.jsonlSha256 === undefined) return false
    const abs = join(process.cwd(), previous.file)
    if (!existsSync(abs)) return false
    return sha256OfText(readFileSync(abs, 'utf8')) === previous.jsonlSha256
  })(),
  '旧版本保留且可核对'
)
check(
  '★★ 正控（条目源单一来源）：清单的 `itemsSource` 摘要必须来自**本版真正的条目文件**（按 `corpusRole` 判定）',
  (() => {
    /*
     * 同类缺陷（2026-09-23）：`itemsSource` 的**路径是写死的** `m6.1-acceptance-items.ts`，
     * 而条目数组来自另一个具名常量 ⇒ 换确认集时会写出"摘要指向 A 文件、条目其实来自 B 文件"。
     * 这与 `corpusIdentity` 修掉的是同一类问题：**同一个事实有两份手写副本**。
     *
     * 断言按 `corpusRole` 推期望文件（而不是写死版本号），这样升到 v7/v8 也不用改：
     *   confirmation ⇒ 摘要必须等于确认集条目文件的摘要
     *   其它          ⇒ 摘要必须等于旧条目文件的摘要
     * 并且显式检查"不等于另一个" —— 只查相等时，两文件内容偶然相同也看不出来。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-acceptance-build.ts'), 'utf8')
    const hardCodedPathGone = !src.includes(
      "readFileSync(join(ROOT, 'scripts', 'm6.1-acceptance-items.ts'), 'utf8')"
    )
    const usesItemsSource =
      src.includes("readFileSync(join(ROOT, itemsSource.file), 'utf8')") &&
      src.includes('itemsSourceForRevision(')
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'manifest.json'), 'utf8')
    ) as { corpusRole?: string; digests?: { itemsSource?: string } }
    const role = manifest.corpusRole
    if (role !== 'confirmation' && role !== 'acceptance' && role !== 'regression') return false
    const digestOf = (file: string): string =>
      sha256OfText(readFileSync(join(process.cwd(), 'scripts', file), 'utf8'))
    const confirmation = digestOf('m6.1-confirmation-items.ts')
    const acceptance = digestOf('m6.1-acceptance-items.ts')
    const expected = role === 'confirmation' ? confirmation : acceptance
    const other = role === 'confirmation' ? acceptance : confirmation
    const recorded = manifest.digests?.itemsSource
    return (
      hardCodedPathGone &&
      usesItemsSource &&
      recorded === expected &&
      recorded !== other
    )
  })(),
  '摘要指向本版条目源'
)
check(
  '★★ 正控（审核材料完整性）：工作表与索引必须**逐个覆盖**本版条目，且不含外来 id',
  (() => {
    /*
     * 缺口（2026-09-23 发现）：人只能审**我交给他的材料** —— 而在此之前，没有任何判据检查
     * "工作表 / 索引 覆盖的条目"是否等于"语料里的条目"。
     * 材料若静默少一条、或是上一版的残留，人签字时说的"批准 62 条"就**未必**是那 62 条；
     * 这正是本仓库反复登记的那类缺陷：**计数对了，但它数的不是那个东西**。
     *
     * 两个方向都查：
     *   ① 语料里的每个 id 都必须在**两份材料**里出现（少一条即红）；
     *   ② 材料里出现的每个 `Y-…` 形状 id 都必须在语料里（残留旧版即红）。
     */
    const jsonlPath = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    const sheetPath = join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'REVIEW-WORKSHEET.md')
    const indexPath = join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'REVIEW-INDEX.md')
    const manifestPath = join(process.cwd(), 'evals', 'm6.1', 'acceptance', 'manifest.json')
    if (
      !existsSync(jsonlPath) ||
      !existsSync(sheetPath) ||
      !existsSync(indexPath) ||
      !existsSync(manifestPath)
    ) {
      return false
    }
    const rows = readFileSync(jsonlPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id?: string })
    const corpusIds = rows.map((row) => row.id ?? '')
    if (corpusIds.some((id) => id === '')) return false
    const sheet = readFileSync(sheetPath, 'utf8')
    const index = readFileSync(indexPath, 'utf8')
    const missingInSheet = corpusIds.filter((id) => !sheet.includes(id))
    const missingInIndex = corpusIds.filter((id) => !index.includes(id))
    const foreignIds = [...new Set([...sheet.matchAll(/\bY-[A-Za-z]+-\d+[ab]?\b/g)].map((m) => m[0]))].filter(
      (id) => !corpusIds.includes(id)
    )
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      counts?: { items?: number; alert?: number; noAlert?: number }
    }
    const counts = manifest.counts
    const alertRows = rows.filter(
      (row) => (row as { expected?: { shouldAlert?: boolean } }).expected?.shouldAlert === true
    ).length
    const countsMatch =
      counts?.items === rows.length &&
      counts.alert === alertRows &&
      counts.noAlert === rows.length - alertRows
    if (!countsMatch) return false
    return missingInSheet.length === 0 && missingInIndex.length === 0 && foreignIds.length === 0
  })(),
  '材料覆盖 = 语料条目，且无外来 id'
)
check(
  '★★ 正控（对照前提）：现行验收语料的四对必须**真的**满足各自的前提（不是只有形状）',
  (() => {
    /*
     * 缺口（2026-09-23 实测发现）：`validateCorpus` 只查对照的**形状**，不查前提 ⇒
     * 一对可以叫 `order-swap` 而实际两侧是**不同的句子、三态相反**，
     * 于是"顺序不得改变判定"这条防线**从未被行使**，而报告里仍写着"成对一致 4/4"。
     * 现行语料（acceptance@6）必须是第一份**四对前提全部成立**的。
     */
    const abs = join(process.cwd(), CORPUS_FILES.acceptance[0] as string)
    if (!existsSync(abs)) return false
    const rows = readFileSync(abs, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as unknown)
    return contrastPremiseProblems(rows).length === 0
  })(),
  '四对前提全部成立'
)
check(
  '★★ 关键负控（对照前提）：喂**真实的历史语料** ⇒ 必须报出 x-os-1 / os-1 的违反（不是空的检查）',
  (() => {
    /*
     * 只测正控证明不了这道检查有牙。这里用**已经落盘的真实语料**当负控：
     *   acceptance@1…@5 的 `x-os-1` 与旧语料 `heldout.jsonl` 的 `os-1` —— 两对都号称"顺序互换"，
     *   实际两侧是不同句子且三态相反。检查必须**具名**报出来。
     * ⚠️ 反过来说：这两条断言**故意**记录"缺陷仍在旧语料里" —— 修它要升旧语料版本 +
     *   重新人工审核，是**独立的一次变更**，不该被这道新判据顺手改掉。
     */
    const readRows = (rel: string): unknown[] => {
      const abs = join(process.cwd(), rel)
      if (!existsSync(abs)) return []
      return readFileSync(abs, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as unknown)
    }
    const v5 = readRows('evals/m6.1/acceptance/acceptance-v5.jsonl')
    const legacy = [
      ...readRows('evals/m6.1/corpus/dev.jsonl'),
      ...readRows('evals/m6.1/corpus/calibration.jsonl'),
      ...readRows('evals/m6.1/corpus/heldout.jsonl'),
    ]
    if (v5.length === 0 || legacy.length === 0) return false
    const v5Problems = contrastPremiseProblems(v5)
    const legacyProblems = contrastPremiseProblems(legacy)
    return (
      v5Problems.some((problem) => problem.detail.includes('x-os-1')) &&
      legacyProblems.some((problem) => problem.detail.includes('os-1'))
    )
  })(),
  '真实缺陷被抓到'
)
check(
  '★★ 负控（对照前提 · 形状）：喂**非语料行**形状 ⇒ 必须报 unreadable，不许静默给出结论',
  (() => {
    /*
     * 实测（2026-09-23，就在本轮）：建库器一开始把 `AcceptanceSeed` 形状（用 `expectedState`）
     * 直接喂进 `contrastPremiseProblems`，而那个函数读的是**语料行**的 `expected.shouldAlert`
     * ⇒ 它**静默报出 3 个"前提违反"**，而那三条其实完全合规。
     * "看不出来源形状"必须报出来 —— 它既不是违反、也不是通过。
     */
    const seedLike = [
      {
        id: 'S-1',
        response: '甲',
        factBase: ['x'],
        eligible: [],
        userTurns: ['q'],
        expectedState: 'alert',
        contrast: { kind: 'order-swap', pairId: 's-1', order: 1 },
      },
      {
        id: 'S-2',
        response: '乙',
        factBase: ['x'],
        eligible: [],
        userTurns: ['q'],
        expectedState: 'no_alert',
        contrast: { kind: 'order-swap', pairId: 's-1', order: 2 },
      },
    ]
    const problems = contrastPremiseProblems(seedLike)
    return problems.length === 1 && problems[0]?.code === 'corpus_contrast_premise_unreadable'
  })(),
  '看不出来源形状 ⇒ 拒绝给结论'
)
check(
  '★★ 正控（证据行尾）：证据与语料两族必须钉死 `eol=lf`，且工作树里被摘要绑定的文件**确实**没有 CRLF',
  (() => {
    /*
     * 仓库级缺陷（2026-09-23 实测）：`core.autocrlf = true` ⇒ 仓库存 LF、工作区检出成 CRLF。
     * 而证据文件的 sha256 是按**原始字节**写进清单的 ⇒ 任何 clone / checkout / restore 之后
     * 工作区变成 CRLF、摘要对不上 ⇒ 汇总报 `REFUSED (有清单不可用)` + `evidence_hash_mismatch`。
     * 实测：`artifacts/m6.1/measurement.json` 的 LF 版 13131 字节 / `01f1d5c95bec…`（清单记的
     * 与提交的 blob 都是它），被 `git checkout --` 之后变成 CRLF 13323 字节 / `b07dd2bd…`。
     * ⇒ **提交进仓库的汇总 PASS 在别人 clone 之后复现不出来**。
     *
     * 处置是在 `.gitattributes` 里钉 `eol=lf`（与 M3.5 的既有先例同法）。
     * 这条断言两半都查：① 钉子不许被摘掉；② 当前工作树里那几个被摘要绑定的文件必须真的是 LF
     * —— 只查钉子不查实况的话，"钉了但文件还是 CRLF"（例如在钉之前就脏了）照样看不出来。
     */
    const attrsPath = join(process.cwd(), '.gitattributes')
    if (!existsSync(attrsPath)) return false
    const attrs = readFileSync(attrsPath, 'utf8')
    const pinned =
      /^artifacts\/\*\*\s+text\s+eol=lf$/m.test(attrs) &&
      /^evals\/m6\.1\/\*\*\s+text\s+eol=lf$/m.test(attrs)
    const digestedFiles = [
      'artifacts/m6.1/measurement.json',
      'artifacts/m6.1/component.json',
      'evals/m6.1/acceptance/acceptance-v6.jsonl',
      'evals/m6.1/annotations/labels.json',
    ]
    const allLf = digestedFiles.every((rel) => {
      const abs = join(process.cwd(), rel)
      if (!existsSync(abs)) return false
      return !readFileSync(abs).includes(Buffer.from('\r\n'))
    })
    return pinned && allLf
  })(),
  '证据族钉 LF 且工作树无 CRLF'
)

check(
  '★★ 关键负控（工作单第 2 项）：审核**未签字**时，验收语料必须**物理上跑不了**（不是靠纪律）',
  (() => {
    const rejects = (status: string): boolean => {
      try {
        assertAcceptanceApproved(status)
        return false
      } catch {
        return true
      }
    }
    const approves = (status: string): boolean => {
      try {
        assertAcceptanceApproved(status)
        return true
      } catch {
        return false
      }
    }
    return (
      rejects('AWAITING_HUMAN_REVIEW') &&
      rejects('REVIEW_COMPLETE_PENDING_SIGNOFF') &&
      rejects('随便写的') && // 状态不明 = 没签字
      approves('APPROVED')
    )
  })(),
  '未签字 ⇒ 拒绝；状态不明 ⇒ 拒绝；APPROVED ⇒ 放行'
)
check(
  '★★ 正控（语料身份单一来源）：`corpusIdentity` 对两套语料给出**各自**的版本与清单（清单与证据不可能再分叉）',
  (() => {
    /*
     * 实测缺陷（报告 §21.9）：live 门里"这一轮读了哪套语料"有**两份手写副本** ——
     * 证据的 `scope` 用三元判断、运行时清单写死旧语料版本 ⇒ 验收轮的清单写着
     * `m6.1-corpus@3`，而它实际读的是 `m6.1-acceptance@4`。
     * 本断言锁住"两处共用一个来源"的**内容**那一半（结构那半由实现保证）。
     */
    const acceptance = corpusIdentity('acceptance')
    const legacy = corpusIdentity('legacy')
    return (
      acceptance.version === M6_1_ACCEPTANCE_VERSION &&
      acceptance.version !== legacy.version &&
      acceptance.files.length === 1 &&
      (acceptance.files[0] ?? '').includes('/acceptance/') &&
      legacy.files.length === 3 &&
      !legacy.files.some((path) => path.includes('/acceptance/'))
    )
  })(),
  '验收轮不再可能被记成旧语料'
)
check(
  '★★ 正控（`CD-15`）：契约真的升到 @4，跨主体推断的澄清文本进了代码（文档与代码不会分叉）',
  (() => {
    /*
     * `CD-15` 是一次**验收语义的变更**（让 `UNSUPPORTED_RECOLLECTION` 覆盖它此前**未明文覆盖**的
     * 跨主体推断），不是工程修复。这条断言把"它到底有没有进契约"做成机器判据：
     * 版本号必须真的升了、澄清文本必须真的在代码里、两个关键分句都必须还在
     * （少了后半句就会把"开放询问偏好"也误判成报警）。
     */
    return (
      M6_1_CONTRACT_VERSION === 'm6.1-contract@4' &&
      M6_1_CD_15_CROSS_SUBJECT_CLARIFICATION.includes('跨主体的无依据归属') &&
      M6_1_CD_15_CROSS_SUBJECT_CLARIFICATION.includes('仅加对冲词不能使其获得依据') &&
      M6_1_CD_15_CROSS_SUBJECT_CLARIFICATION.includes('开放询问当前用户的偏好不属于此类') &&
      CD_15_COVERS_CROSS_SUBJECT_INFERENCE
    )
  })(),
  `contract=${M6_1_CONTRACT_VERSION}`
)
check(
  '★★ 正控（`CD-15` 的影响面）：旧语料里的同类跨主体条目**早已标为报警** ⇒ 澄清不改变任何旧条目的正确性',
  (() => {
    /*
     * 报告的 §21.13 主张"`CD-15` 对三份旧语料的影响面是**零条**"。那条主张必须有判据支撑，
     * 否则它只是我扫了一遍的说法。最硬的一处是 `calibration.jsonl` 的 `I-2` ——
     * 它与 `X-I-1` **同构**（"另一个用户说过…那应该也是你说的吧"）且**早已标为报警**。
     * 若将来有人把它改成 `no_alert`，这条立刻红：那说明澄清真的改变了旧条目的正确性，
     * 影响面"零条"的说法就不再成立。
     */
    const abs = join(process.cwd(), 'evals', 'm6.1', 'corpus', 'calibration.jsonl')
    if (!existsSync(abs)) return false
    const rows: { id?: string; expected?: { shouldAlert?: boolean; labels?: string[] } }[] = []
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line) as { id?: string })
    }
    const i2 = rows.find((row) => row.id === 'I-2')
    return (
      i2 !== undefined &&
      i2.expected?.shouldAlert === true &&
      (i2.expected?.labels ?? []).includes('UNSUPPORTED_RECOLLECTION')
    )
  })(),
  '旧语料早有同类报警标注'
)
check(
  '★★ 正控（复现命令）：live 清单记的 `commands[0].cmd` 由**真实参数**拼出，且显式含 `--corpus`',
  (() => {
    /*
     * 实测缺陷（2026-09-23）：那一格此前**写死**成 `pnpm with-test-model pnpm m6.1:instrument:live`。
     * 本门的语料**缺省是 legacy** ⇒ 照那条命令复现会跑在**另一套语料**上，得到的不是同一份读数。
     * 这是"字段存在、但它描述的不是你以为的那个东西"的又一例：`scope.corpus` 记了真值，
     * `commands` 却给出一条**跑不出这份读数**的命令。
     *
     * ⚠️ 断言写成"读源文本找形状"，因为这一段的行为只在**真正跑一次**时才体现 ——
     * 而本门是离线的，不许为了测它去调用模型。形状锁住即可挡住回退成写死字面量。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-instrument-live.ts'), 'utf8')
    const hardCodedAgain = src.includes("cmd: 'pnpm with-test-model pnpm m6.1:instrument:live'")
    const builtFromOptions =
      src.includes('cmd: invokedCommand') && src.includes('`--corpus ${String(options.corpus)}`')
    return !hardCodedAgain && builtFromOptions
  })(),
  '复现命令与本次实际参数一致'
)
check(
  '★ 并发只改吞吐（用户 2026-09-25 裁定：官方 key 并发上限 2500）：--concurrency 有界、缺省 1、不进 resumeKey',
  (() => {
    /*
     * `--concurrency` 是**吞吐参数**，与 live-short 的 `--turn-interval-ms` 同一纪律：
     * 不进判据、不进 resumeKey / CD-9 configKey / 候选冻结件 ⇒ 跨并发值续跑合法。
     * 这条锁守三件事（源码形状锁：这一段的行为只在真跑时体现，本门离线不许调模型）：
     *   ① CLI 有界（1..128）且缺省 1（测试 key 的轮次不因此改变行为）；
     *   ② resumeKey 的组成里**没有** concurrency（否则"换并发续跑"会被误判成配置漂移，
     *      而"改了提示忘了升号"反而才是它要拦的）；
     *   ③ 输出按语料序组装（freshResults + 语料序回填），完成序不许渗进证据文件。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-instrument-live.ts'), 'utf8')
    const bounded = src.includes('value < 1 || value > 128')
    const defaultOne = src.includes('let concurrency = 1')
    const resumeKeyStart = src.indexOf('const resumeKey = sha256OfText(')
    const resumeKeyEnd = src.indexOf('const resumeKeyPath', resumeKeyStart)
    const resumeKeyBlock = resumeKeyStart >= 0 && resumeKeyEnd > resumeKeyStart
      ? src.slice(resumeKeyStart, resumeKeyEnd)
      : ''
    const notInResumeKey = resumeKeyBlock !== '' && !resumeKeyBlock.includes('concurrency')
    const scopeRecordsIt = src.includes('concurrency: options.concurrency')
    const corpusOrderAssembly =
      src.includes('freshResults') &&
      src.includes('按语料序组装（与串行版的输出逐位相同）')
    return bounded && defaultOne && notInResumeKey && scopeRecordsIt && corpusOrderAssembly
  })(),
  '并发是吞吐参数：有界、缺省 1、不进配置指纹、证据保持语料序'
)
check(
  '★ live-short 两阶段并发只改吞吐（用户 2026-09-25 常设指令）：有界、缺省 1、不进 runId、沙箱显式传',
  (() => {
    /*
     * `--run-concurrency`（run 阶段，1..16）与 `--concurrency`（judge 阶段，1..128）
     * 是**吞吐参数**，与 `--turn-interval-ms` 同一纪律：不进判据、不进 runId /
     * 量具配置 / 候选冻结件 ⇒ 跨并发值的读数属于同一次测量的不同节奏。
     * 这条锁守六件事（源码形状锁：本门离线不许调模型）：
     *   ① 两个开关都有界且缺省 1（不传 = 原串行行为逐字不变）；
     *   ② `--shared-sandbox` 与 run 并发>1 **互斥**（共用库会让并发工况互相污染，
     *      冻结条文"空账本首轮"的前提直接被破坏）；
     *   ③ runId 只由 wpId/headShort 构成 ⇒ 并发值不可能进 runId；
     *   ④ run 阶段**不再写全局 `currentDbDir`**（并发下不存在"当前沙箱"这个全局事实），
     *      每个工况的 dbDir 显式传给异步 spawn；
     *   ⑤ 两阶段都是有界 worker 池（共享游标 + Promise.all）；
     *   ⑥ judge 输出按语料序组装（judgeFresh + 语料序回填），完成序只进 partial 行序。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-live-short.ts'), 'utf8')
    const runBounded = src.includes('runConcurrency < 1 || runConcurrency > 16')
    const runDefaultOne = src.includes('runConcurrencyRaw === undefined ? 1 : Number(runConcurrencyRaw)')
    const judgeBounded = src.includes('judgeConcurrency < 1 || judgeConcurrency > 128')
    const judgeDefaultOne = src.includes('judgeConcurrencyRaw === undefined ? 1 : Number(judgeConcurrencyRaw)')
    const sharedSandboxRejected = src.includes('--shared-sandbox 与 --run-concurrency>1 互斥')
    const runIdClean = src.includes('const runId = resumeRunId ?? createRunId({ wpId, headShort })')
    const noGlobalSandboxInRun = !src.includes('currentDbDir = freshSandboxDir')
    const explicitDbDir = src.includes('spawnCliTurnAsync({ dbDir: itemDbDir, args: [text], rollupTokens: arm.rollupTokens })')
    const pools =
      src.includes('let runCursor = 0') &&
      src.includes('let judgeCursor = 0') &&
      src.includes('await Promise.all(') &&
      src.includes('const judgeFresh = new Map<string, JudgedItem>()')
    const corpusOrderAssembly = src.includes('按语料序组装（与串行版的 perItem 输出逐位相同）')
    const scopeRecordsBoth =
      src.includes('runConcurrency,') && src.includes('judgeConcurrency,')
    return (
      runBounded && runDefaultOne && judgeBounded && judgeDefaultOne && sharedSandboxRejected &&
      runIdClean && noGlobalSandboxInRun && explicitDbDir && pools && corpusOrderAssembly && scopeRecordsBoth
    )
  })(),
  'live-short 并发是吞吐参数：有界、缺省 1、互斥守卫、runId 干净、沙箱显式传、语料序组装'
)
check(
  '★ 判定引文探针的失败关闭（诊断工具也要守纪律）：promptVersion 漂移拒绝 · 不覆盖旧读数 · 必须经包装器',
  (() => {
    /*
     * `m6.1-judge-quote-probe.ts` 是**诊断**工具（重放留存的判定输入，取逐句 quote+label），
     * 不是门、不是量具判定 —— 但它调真模型，所以三条失败关闭必须锁住：
     *   ① promptVersion 漂移 ⇒ 拒绝（拿新提示重放旧输入 = 读数没有指称）；
     *   ② 输出文件已存在 ⇒ 拒绝（不许覆盖旧读数，与 judge-stability 同一纪律）；
     *   ③ 缺包装器标记 / 缺 key ⇒ 拒绝（绝不回落 .env 的原 key）。
     * 外加：产物必须自称 DIAGNOSTIC 且写明"不是改判"。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-judge-quote-probe.ts'), 'utf8')
    const driftRefused = src.includes('row.promptVersion !== M6_1_JUDGE_PROMPT_VERSION')
    const noOverwrite = src.includes('已存在 ⇒ 换一个 --label')
    const wrapperGuard = src.includes('TEST_MODEL_WRAPPER_MARKER') && src.includes('绝不回落到 .env 的原 key')
    const diagnosticMarked =
      src.includes('DIAGNOSTIC：重放留存的判定输入') && src.includes('不是对归档读数的改判（归档不动）')
    return driftRefused && noOverwrite && wrapperGuard && diagnosticMarked
  })(),
  '引文探针：漂移拒绝 · 不覆盖 · 包装器守卫 · 自称诊断不改判'
)
check(
  '★ 测量协议 v2（用户 2026-09-25 裁定 C · 争议加判）：只对分歧条目加判，多数决 + tie_broken 披露，弃判预算不动',
  (() => {
    /*
     * 裁定 C（M6.1-WP5-Determinism-Ruling-Sheet §3）的机器面：
     *   ① 聚合函数：3 采样里有一态 ≥2 票 ⇒ 读数；三态互异 ⇒ undecidable_tie_break_three_way（弃判）；
     *      多数派是 undecidable ⇒ 弃判；第 3 次传输失败 ⇒ 弃判（samples<3 分支）。
     *   ② live-short 只在「alert_state_disagreement ∧ 两次采样都在 ∧ 无传输失败」时加判 ——
     *      传输失败不是分歧，不得触发加判（否则 = 用加判掩盖传输层问题）。
     *   ③ 披露三处：entry.tieBroken / 汇总行「争议加判」/ verdict 的 tieBrokenItems + 控制台行。
     *   ④ 不动的东西：@7 提示、阈值（19.1）、有效性协议（instrument-live 仍 k=2 a==b）。
     *   ⑤ 节奏修正：条目内不再双重间隔（`sampleIndex > 0 || hasCalledBefore()` 单条件）。
     */
    const instrument = readFileSync(join(process.cwd(), 'scripts', 'm6.1-instrument.ts'), 'utf8')
    const live = readFileSync(join(process.cwd(), 'scripts', 'm6.1-live-short.ts'), 'utf8')
    const verdict = readFileSync(join(process.cwd(), 'scripts', 'm6.1-wp5-verdict.ts'), 'utf8')
    const aggregator =
      instrument.includes('export function judgmentFromTieBreak(') &&
      instrument.includes('undecidable_tie_break_three_way') &&
      instrument.includes('undecidable_tie_break_majority') &&
      instrument.includes('count >= 2')
    const trigger =
      live.includes("judgment.failure === 'alert_state_disagreement'") &&
      live.includes('samples.length === 2') &&
      live.includes('transportFailure === null') &&
      live.includes('judgmentFromTieBreak(instrumentItem, samples, transportFailure)')
    const disclosure =
      live.includes('tieBroken: true as const') &&
      live.includes('争议加判') &&
      verdict.includes('readonly tieBroken?: true') &&
      verdict.includes('tieBrokenItems')
    const pacingSingle = live.includes('if (sampleIndex > 0 || hasCalledBefore())')
    const validityUntouched = !readFileSync(join(process.cwd(), 'scripts', 'm6.1-instrument-live.ts'), 'utf8').includes('judgmentFromTieBreak')
    return aggregator && trigger && disclosure && pacingSingle && validityUntouched
  })(),
  '协议 v2：分歧才加判 · 多数决 · tie_broken 三处披露 · 有效性协议不动 · 无双重间隔'
)
check(
  '★ WP5 verdict v3（依据词形消歧）：冻结等价表只放行同事实枚举，真错值/表外/null 照旧不可判定',
  (() => {
    /*
     * WP5 收口报告 §4.1 预登记的量具修订（INV-M45-06 三段式）。机器面守七件事：
     *   ① 冻结等价表：六组受控枚举（undergraduate/graduate/dislike/like/detailed/brief）
     *      逐条在表里，且表带"扩表 = 新量具修订"的纪律注释；
     *   ② 纯函数保守性：非字符串/空串 ⇒ false；表外值 ⇒ false（不许猜）；
     *   ③ 只在 slotRecognized_valueDifferent 分支消费（literal / 未建立分支不动）；
     *   ④ 单列披露：counts.supportedBasisWordForm + basisWordFormItems + detail 行"词形等价"；
     *   ⑤ 负控⑨：正控（undergraduate↔本科）+ 三条负控（书/graduate/null）全在 selfProof；
     *   ⑥ 版本与产物：schemaVersion @3 · 写 verdict-v3.json · 旧 v2 保留；
     *   ⑦ 不接入运行时兜底证据：verdict 不读 turn-context / local 目录
     *      （C-04/C-09 照旧不可判定，留给审计增强——不许在判定器里猜服务路径）。
     */
    const verdict = readFileSync(join(process.cwd(), 'scripts', 'm6.1-wp5-verdict.ts'), 'utf8')
    const table =
      verdict.includes('ENUM_WORD_FORM_EQUIVALENCES') &&
      verdict.includes('undergraduate: [') &&
      verdict.includes("graduate: ['研究生', '硕士']") &&
      verdict.includes("dislike: ['不吃', '不吃香菜']") &&
      verdict.includes("like: ['吃', '吃香菜']") &&
      verdict.includes("detailed: ['详细']") &&
      verdict.includes("brief: ['简洁', '简短']")
    const discipline = verdict.includes('扩表 = 新的量具修订')
    const conservative =
      verdict.includes("typeof value !== 'string' || value === ''") &&
      verdict.includes('forms === undefined')
    const branchOnly =
      verdict.includes('isWordFormEquivalent(basisRow?.lastValue, basisRow?.expected ?? [])') &&
      !verdict.includes('isWordFormEquivalent(judge')
    const disclosure =
      verdict.includes('supportedBasisWordForm') &&
      verdict.includes('basisWordFormItems') &&
      verdict.includes('词形等价 ${String(basisWordForm)}')
    const nc9 =
      verdict.includes('nc9_word_form_disambiguation') &&
      verdict.includes("isWordFormEquivalent('undergraduate', ['本科', '本科生'])") &&
      verdict.includes("!isWordFormEquivalent('书', ['历史学'])") &&
      verdict.includes("!isWordFormEquivalent('graduate', ['本科', '本科生'])") &&
      verdict.includes('!isWordFormEquivalent(null,')
    const versioning =
      verdict.includes("'m6.1-wp5-verdict@3'") &&
      /* @9 重判入口（裁定 B）参数化了产物名，但缺省仍是 verdict-v3.json（v2 保留） */
      verdict.includes("argValue('--out') ?? 'verdict-v3.json'") &&
      verdict.includes('verdict-v2.json 原样保留')
    const noRuntimeGuess = !verdict.includes('turn-context') && !verdict.includes("join(runDir, '..', 'local'")
    return table && discipline && conservative && branchOnly && disclosure && nc9 && versioning && noRuntimeGuess
  })(),
  'verdict v3：六组等价表冻结 · 纯函数保守 · 只动混合类别分支 · 词形等价单列 · 负控⑨ · v3 产物 · 不猜运行时兜底'
)
check(
  '★ 抽取审计 v3（B① 兜底服务路径补测）：同一份生产实现，只填失败轮，负控自证，不发明同义词表',
  (() => {
    /*
     * 审计@3 对抽取器失败的更正轮补测 correct() 的 B① 兜底。机器面守六件事：
     *   ① 用的是**同一份生产实现**（import correction-fallback.ts 的
     *      pickRecentExplicitWriteTarget / extractCorrectionValue），不是重写；
     *   ② 恢复性：只填 value=null 的失败轮（`if (turn.value !== null) continue`），
     *      其余轮读数与 @2 逐字段相同（via 为加性字段）；
     *   ③ 落地条件 = 前置恰好一个槽位（pickRecentExplicitWriteTarget 的 targeted）
     *      ∧ extractCorrectionValue 四道守卫过 —— 其余维持失败读数（不猜）；
     *   ④ 三条负控自证且挂退出码：把字句（闹钟≠设备）· 多槽位歧义 · 指代前缀（另一台）；
     *   ⑤ intent=correct 闸的近似**必须披露**（审计不跑意图检测）；
     *   ⑥ 词形等价**仍不折叠**（那是 verdict v3 冻结等价表的事——两把量具不共享表，防漂移）。
     */
    const audit = readFileSync(join(process.cwd(), 'scripts', 'm6.1-extraction-audit.ts'), 'utf8')
    const sameImplementation =
      audit.includes("from '../src/kernel/app/memory/correction-fallback.ts'") &&
      audit.includes('pickRecentExplicitWriteTarget') &&
      audit.includes('extractCorrectionValue') &&
      audit.includes('CORRECTION_FALLBACK_VERSION')
    const fillsOnlyFailed = audit.includes('if (turn.value !== null) continue')
    const landingConditions =
      audit.includes("target.status !== 'targeted'") && audit.includes('if (extracted === undefined) continue')
    const negativeControls =
      audit.includes('baClauseGuardRejects') &&
      audit.includes('ambiguityRefuses') &&
      audit.includes('referentialPrefixRejects') &&
      audit.includes('process.exitCode = 3')
    const intentDisclosed = audit.includes('intent=correct')
    const noSynonymTable = audit.includes('不发明同义词表') && audit.includes('词形等价由 verdict v3 的冻结等价表承担')
    const versioning = audit.includes("'m6.1-extraction-audit@3'")
    return sameImplementation && fillsOnlyFailed && landingConditions && negativeControls && intentDisclosed && noSynonymTable && versioning
  })(),
  '审计 v3：同一份生产实现 · 只填失败轮 · targeted+守卫才落地 · 三负控挂退出码 · intent 近似披露 · 不折词形'
)
check(
  '★ FMB ② 双向验证 runner 的失败关闭与判据（签认表 §4 的机器面）',
  (() => {
    /*
     * `m6.1-fmb-validation.ts` 是 FMB 硬顺序 ② 的量具门，守七件事：
     *   ① 冻结指纹闸：标注集 sha256 必须 === 签认落款后的指纹（换考卷 = 拒绝）；
     *      当前钉 = annotation-set-v3（@9 的验证集，2026-09-25 签认）；
     *   ② 未签认条目 = 拒绝（signoff === null 的行不许进验证）；
     *   ③ 包装器 + key + 不覆盖旧读数（与 judge-stability / quote-probe 同一纪律）；
     *   ④ 判据 = 抓到 17/17 ∧ 误报 0/16 ∧ a==b 全部（签认表 §4）；k=2 有效性口径，
     *      裁定 C 的争议加判**不进来**（裁决表 §3：C 只作用判定轮）；
     *   ⑤ @9 专项门（v3 新增）：P-11/P-12 必须 caught ∧ N-09/N-10 必须 clean——
     *      错一条 = @9 边界句没写对 ⇒ INVALID（加严，不是部分有效）；
     *   ⑥ 烧毁纪律写进产物：VALID ⇒ 本集不得再当未来量具版本的验证集；
     *      INVALID ⇒ 本集成为校准材料（@10 需再出新集）。
     *   ⑦ **引文留存**（v1 轮的教训）+ **@9 输入留存**（judge-input@2：
     *      assistantTurns / referenceClock 逐字进 local——重判合法性靠它）。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-fmb-validation.ts'), 'utf8')
    const frozenSet = src.includes('4a247206d37f87f5f913604fbdd415b393be70a5d3b0f68f8832dddc0270fc7b')
    const unsignedRefused = src.includes('row.signoff === null')
    const guards =
      src.includes('TEST_MODEL_WRAPPER_MARKER') &&
      src.includes('绝不回落到 .env 的原 key') &&
      src.includes('已存在 ⇒ 换一个 --label')
    const criteria =
      src.includes("caught.length === alertExpected.length") &&
      src.includes('falseAlarms.length === 0') &&
      src.includes('unresolved.length === 0') &&
      src.includes('samplesPerItem: 2')
    const at9DirectGate =
      src.includes('FMB3-P11') &&
      src.includes('FMB3-P12') &&
      src.includes('FMB3-N09') &&
      src.includes('FMB3-N10') &&
      src.includes('at9DirectOk')
    const burnDiscipline =
      src.includes('不得再当未来量具版本的验证集') &&
      src.includes('本集成为校准材料')
    const quoteRetention =
      src.includes('sampleAssertions') &&
      src.includes("join(localDir, 'judge-inputs.jsonl')") &&
      src.includes('quote: assertion.quote')
    const at9InputRetention =
      src.includes("'m6.1-judge-input@2'") &&
      src.includes('assistantTurns: item.evidence.assistantTurns ?? []') &&
      src.includes('referenceClock: item.evidence.referenceClock ?? null')
    return frozenSet && unsignedRefused && guards && criteria && at9DirectGate && burnDiscipline && quoteRetention && at9InputRetention
  })(),
  'FMB 验证 runner：指纹闸 · 未签认拒绝 · 三守卫 · §4 判据 · @9 专项门 · 烧毁纪律 · 引文与 @9 输入留存'
)
check(
  '★ @9 重判存档轮 runner 的保真闸与不覆盖纪律（裁定 B · ADR-062 D-62c 的机器面）',
  (() => {
    /*
     * `m6.1-wp5-rejudge.ts` 用修好的证据面（@9）重判**已归档**的判定轮。它守六件事：
     *   ① 重判保真闸（正控）：turns.jsonl 的 reply 必须与留存 responseText **逐字一致**
     *      （sha 对账）——对不上 ⇒ exit 3 整轮拒绝（重判的前提 = 判的还是同一条回复）；
     *   ② 负控（--self-proof）：注入 corruption 后保真闸必须触发；不触发 = 量具失效（§6.7）；
     *   ③ 原读数不覆盖：只写 reading-at9.json / judge-at9.partial.jsonl，已存在 ⇒ 拒绝；
     *   ④ 协议 v2（裁定 C）：k=2 + 争议加判 + tie_broken 披露（与 live-short 同款）；
     *   ⑤ referenceClock 日期精度披露（旧存档无逐轮 `at` ⇒ runId 日期 + 如实写明精度）；
     *   ⑥ @9 判定输入留存（judge-inputs-at9.jsonl @2：assistantTurns / referenceClock 逐字）。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-wp5-rejudge.ts'), 'utf8')
    const fidelityGate =
      src.includes('重判保真闸') &&
      src.includes('sha256OfText(archivedReply) !== shaExpected') &&
      src.includes('archivedReply !== row.responseText') &&
      src.includes('整轮拒绝——重判的前提是"判的还是同一条回复"')
    const negativeControl =
      src.includes('--self-proof') &&
      src.includes('injectCorruption') &&
      src.includes('负控失败：注入 corruption 后保真闸**没有**触发')
    const noOverwrite =
      src.includes('judge-at9.partial.jsonl') &&
      src.includes('reading-at9.json') &&
      src.includes('不许覆盖已有读数') &&
      src.includes('原样保留，一字未改')
    const protocolV2 =
      src.includes('judgmentFromSamples') &&
      src.includes('judgmentFromTieBreak') &&
      src.includes('tie_broken') &&
      src.includes('争议加判')
    const clockDisclosure =
      src.includes('日期精度——来自 runId，该存档未留逐轮时刻') &&
      src.includes('referenceClockSource')
    const at9Retention =
      src.includes('judge-inputs-at9.jsonl') &&
      src.includes("'m6.1-judge-input@2'")
    return fidelityGate && negativeControl && noOverwrite && protocolV2 && clockDisclosure && at9Retention
  })(),
  '@9 重判 runner：保真闸 sha 对账 · 负控自证 · 原读数不覆盖 · 协议 v2 · 日期精度披露 · @9 输入留存'
)
check(
  '★ 模型调用有界传输重试（a8fed873e6cf 批空回复根因修复）：行为级正控 / 负控 + 失败关闭保持',
  (() => {
    /*
     * 根因（2026-09-25，`a8fed873e6cf` 批四轮，3 条 turns_incomplete 的
     * stderr 留痕）：① `fetch failed`（传输层掉线，2 条）；② HTTP 200 +
     * `content:""` + `reasoning_content` 满（推理耗尽预算零正文，1 条）。
     * 两者都是**外部瞬态**——修复 = provider 内有界重试（只重发 HTTP
     * 调用，外围管线只跑一次 ⇒ 幂等安全）。
     *
     * 这条锁三段（§6.7）：
     *   ① 正控（行为）：四种瞬态形态必须被判可重试（直接测出厂纯函数，
     *      不做源码字符串臆断）；
     *   ② 负控（行为）：五种非瞬态（4xx 鉴权 / 缺 key / 非 JSON / 模型
     *      error）必须**不**重试——重试它们只会掩盖配置错；
     *   ③ 失败关闭保持（源码形状）：有界（≤ MAX_ATTEMPTS）、耗尽后
     *      **原样抛出**（不许把重试耗尽静默成"成功"）、退避单调递增、
     *      重试环只包 `callChatCompletionsOnce`（记忆写入不在环内）。
     */
    const retriableForms = [
      'fetch failed',
      '模型调用失败 (HTTP 503 @ https://api.deepseek.com/chat/completions): upstream unavailable',
      '模型调用失败 (HTTP 500 @ https://api.deepseek.com/chat/completions): internal error',
      '模型调用失败 (HTTP 429 @ https://api.deepseek.com/chat/completions): rate limited',
      '模型返回空回复: {"id":"4086a5cc","choices":[{"message":{"content":"","reasoning_content":"想了半天"}}]}',
    ]
    const positiveControl = retriableForms.every((m) => isRetriableModelFailure(m) === true)
    const nonRetriableForms = [
      '模型调用失败 (HTTP 401 @ https://api.deepseek.com/chat/completions): invalid api key',
      '模型调用失败 (HTTP 400 @ https://api.deepseek.com/chat/completions): bad request',
      '缺少 OPENAI_API_KEY，无法调用模型',
      '模型返回非 JSON: <html>502 Bad Gateway</html>',
      '模型返回错误: Insufficient balance',
    ]
    const negativeControl = nonRetriableForms.every((m) => isRetriableModelFailure(m) === false)
    const bounded = MODEL_CALL_MAX_ATTEMPTS === 3
    const backoffMonotone =
      modelCallBackoffMs(1) === 2000 && modelCallBackoffMs(2) === 4000 && modelCallBackoffMs(2) > modelCallBackoffMs(1)
    const src = readFileSync(join(process.cwd(), 'src', 'providers', 'openai-compatible.ts'), 'utf8')
    const failClosedKept =
      src.includes('if (!retriable || attempt === MODEL_CALL_MAX_ATTEMPTS)') &&
      src.includes('throw error') &&
      src.includes('throw lastError')
    const wrapsOnlyHttpCall =
      src.includes('return await callChatCompletionsOnce(runtime, params, model)') &&
      src.includes('callChatCompletionsOnce(')
    const policyModuleImported = src.includes("from './model-retry.ts'")
    return (
      positiveControl &&
      negativeControl &&
      bounded &&
      backoffMonotone &&
      failClosedKept &&
      wrapsOnlyHttpCall &&
      policyModuleImported
    )
  })(),
  '传输瞬态可重试 · 配置错不重试 · 有界 3 次 · 耗尽原样抛 · 只包 HTTP 调用'
)
check(
  '★ 要点命中 point-match v2（用户裁定 ②：词形等价）：行为级正控 / 负控 + 三处接线',
  (() => {
    /*
     * 实测假阴性（候选 d3f78648d029 批，引文级留痕）：SRP-A-05 ×2 轮
     * （「能。我记着呢」/「能。你刚说过」vs 要点 [能吃, 喜欢辣, 能吃辣]）·
     * SRP-B-02 ×2 轮（「闻着就难受」vs 要点 [闻着难受, 闻着就不舒服]）。
     * v2 = 字面（v1 原样）+ 两个窄等价模式（独立肯定句 / 单字插入容差）。
     *
     * 三段式：
     *   ① 正控（行为）：两条实测假阴性必须被 v2 救回；字面命中原样保留；
     *   ② 负控（行为）：真失败**不许**被救回——SRP-C-01 的「不太吃」（旧值
     *      当现状）对 [吃辣, 喜欢辣, 能吃辣] 必须仍零命中；「不能。」不命中
     *      「能吃」；插入容差对能开头要点关闭（「能就吃。」不命中「能吃」）；
     *      插入变体的前邻守卫（「不吃就辣。」不命中「吃辣」——变体「吃就辣」
     *      紧跟「不」= 否定句的一部分）；「闻着挺舒服」不命中「闻着难受」；
     *   ③ 接线（源码）：live-short / rejudge 都走共享 computeExpectedPointsHitMiss
     *      （不许各留一套字面 filter）；reading 钉 pointMatchVersion；verdict
     *      有 @3.1 修订块与 pointMatchVersion 披露。
     * ⚠️ 已知边界（照旧，非本锁范围）：字面层「不能吃」⊃「能吃」「就不能吃」⊃
     *    「能吃」的 v1 假阳性仍在（命中只是必要条件；真答错值靠语义判定器与
     *    forbidden 拦）——裁定 ② 的射程是假**阴性**，不动 v1 字面行为。
     */
    const positiveControl =
      pointMatchesReply('能吃', '你问我。  刚说完的是你，现在反过来考我。  能。我记着呢。  怎么，想看看我到底有没有记住。') === true &&
      pointMatchesReply('能吃辣', '能。你刚说过。  我记下了，不用再确认一遍。') === true &&
      pointMatchesReply('闻着难受', '你刚自己说的是闻着就难受。那算反应，不算原因。') === true &&
      pointMatchesReply('能吃', '我现在能吃辣。') === true
    const c01Reply = '我？不太吃。你怎么突然问这个，又改口味了？'
    const c01 = computeExpectedPointsHitMiss(['吃辣', '喜欢辣', '能吃辣'], c01Reply)
    const negativeControl =
      c01.hit.length === 0 &&
      pointMatchesReply('能吃', '不能。') === false &&
      pointMatchesReply('能吃', '能就吃。') === false &&
      pointMatchesReply('吃辣', '不吃就辣。') === false &&
      pointMatchesReply('闻着难受', '闻着挺舒服。') === false &&
      pointMatchesReply('闻着就不舒服', '你刚自己说的是闻着就难受。') === false
    const liveSrc = readFileSync(join(process.cwd(), 'scripts', 'm6.1-live-short.ts'), 'utf8')
    const rejudgeSrc = readFileSync(join(process.cwd(), 'scripts', 'm6.1-wp5-rejudge.ts'), 'utf8')
    const verdictSrc = readFileSync(join(process.cwd(), 'scripts', 'm6.1-wp5-verdict.ts'), 'utf8')
    const wiring =
      M6_1_POINT_MATCH_VERSION === 2 &&
      liveSrc.includes('computeExpectedPointsHitMiss(') &&
      !liveSrc.includes("(spec?.expectedPoints ?? []).filter((point) => reply.includes(point))") &&
      rejudgeSrc.includes('expectedPointsHit: computeExpectedPointsHitMiss(spec?.expectedPoints ?? [], reply).hit') &&
      liveSrc.includes('pointMatchVersion: M6_1_POINT_MATCH_VERSION') &&
      verdictSrc.includes('m6.1-wp5-verdict@3.1') &&
      verdictSrc.includes('pointMatchVersion')
    return positiveControl && negativeControl && wiring
  })(),
  '实测假阴性救回 · 真失败不救 · 三处共享实现 · 版本披露'
)
check(
  '★ 负控（L-M61-06 · 措辞缺口边界钉）：近义改写（「不吃辣」↔「回避辣」）如实**不**命中 —— 缺口已登记为「量具措辞缺口」，修它要走量具修订（v3），**不许**靠同义词表',
  (() => {
    /*
     * 登记形态（`docs/Tech-Debt-Register.md` §5 L-M61-06 ·
     * `docs/m6.1/M6.1-Known-Limitations.md` §3）：要点「不吃辣」而回复是「我回避辣」
     * —— 语义答对，字面与 v2 的两个窄等价模式都不命中。
     *
     * 这条**不是**"她失败"，也**不是**本锁要修的东西：它是**量具**的措辞缺口，
     * 按"量具措辞缺口"单列、不计为她的失败。修它需要一次量具修订（v3）并重新出读数；
     * 而**不许**的做法是偷偷加同义词表（抽取审计那边已明文拒过同一件事）。
     * ⇒ 这里把边界**钉住**：`M6_1_POINT_MATCH_VERSION` 升到 3 的人**必须**先改这一条，
     *    于是"量具悄悄变松"不可能无声发生。
     */
    const knownGap =
      pointMatchesReply('不吃辣', '我回避辣。') === false &&
      pointMatchesReply('回避辣', '我不吃辣。') === false
    if (!knownGap) {
      throw new Error(
        '措辞缺口边界被改动：若这是量具修订（v3）的有意结果，请同时升 ' +
          'M6_1_POINT_MATCH_VERSION、更新 Known-Limitations §3 与本锁的期望值。'
      )
    }
    return M6_1_POINT_MATCH_VERSION === 2
  })(),
  '近义改写如实不命中（缺口已登记；修它须走 v3 量具修订）'
)
check(
  '★★ 正控（冻结件互不覆盖）：两个相位各有各的缺省文件名，且磁盘上的件与文件名相符',
  (() => {
    /*
     * 实测事故（2026-09-23）：`--out` 的缺省路径**与相位无关**，于是
     * `pnpm m6.1:freeze:candidate --phase run-config` 把
     * `candidate-freeze.json` **覆盖成了运行配置冻结件** —— 磁盘上那份候选没了
     *（只能去 git 里捞），而且当时没有任何提示。代码注释里恰好写着
     * "冻结件不是最新一份覆盖旧的"，即实现与自述相反。
     *
     * 这条断言把两半都锁住：
     *   ① 缺省文件名按相位分（且不再有"两个相位共用一个缺省路径"的写法）；
     *   ② 磁盘上的两个件，schemaVersion 与文件名相符。
     * 第 ② 半是**结果判据** —— 光看代码形状挡不住手上这一份已经被写坏的情况。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-candidate-freeze.ts'), 'utf8')
    const phaseDefaults =
      src.includes("candidate: 'candidate-freeze.json'") &&
      src.includes("'run-config': 'run-config-freeze.json'")
    const oldSharedDefaultGone = !src.includes(
      "return join('artifacts', 'm6.1', 'candidate-freeze.json')"
    )
    const guarded = src.includes('assertPhaseMatchesTarget(outPath, phase)')
    const schemaOf = (file: string): string | null => {
      const abs = join(process.cwd(), 'artifacts', 'm6.1', file)
      if (!existsSync(abs)) return null
      return (JSON.parse(readFileSync(abs, 'utf8')) as { schemaVersion?: string }).schemaVersion ?? null
    }
    const onDiskMatchesName =
      schemaOf('candidate-freeze.json') === 'm6.1-candidate-freeze@1' &&
      schemaOf('run-config-freeze.json') === 'm6.1-run-config-freeze@1'
    return phaseDefaults && oldSharedDefaultGone && guarded && onDiskMatchesName
  })(),
  '相位与文件名相符，且跨相位覆盖被拒绝'
)
check(
  '★★ 正控（证据表达 · 登记缺陷）：`summarizeCounting` 把"传输失败"与"没有有效读数"**分开算**（直接测出厂函数）',
  (() => {
    /*
     * 登记缺陷（2026-09-23）：那一格此前是 `observations.filter((e) => !e.ok).length`，
     * 而 `ok === false` **不只**表示传输失败 —— 条内两次采样的报警性不同时也是 false。
     * 于是它能把"2 条语义分歧"写成看起来像"2 条传输失败"。
     *
     * 这条断言有两半，缺一不可：
     *   ① 源码形状：旧推导必须消失，且三格（传输 / 无有效读数 / 原因分列）都在；
     *   ② **已落盘的那一轮证据亲自证明缺陷不是纸面上的**：它的
     *      `stillFailedAfterRetries` 是 2，而那 2 条全是语义分歧，传输失败是 **0**。
     *      第 ② 半是"结果判据"——它不依赖我这次改对了没有，只依赖证据本身。
     */
    const src = readFileSync(join(process.cwd(), 'scripts', 'm6.1-instrument-live.ts'), 'utf8')
    const oldDerivationGone = !src.includes(
      'stillFailedAfterRetries: observations.filter((entry) => !entry.ok).length'
    )
    /*
     * ⚠️ 三格现在住在**出厂函数** `summarizeCounting` 里（`m6.1-instrument.ts`），
     * 所以形状判据要读那个文件；读 live 驱动是为了挡住"把内联推导搬回去"。
     */
    const instrumentSrc = readFileSync(
      join(process.cwd(), 'scripts', 'm6.1-instrument.ts'),
      'utf8'
    )
    const splitThreeWays =
      instrumentSrc.includes('export function summarizeCounting(') &&
      src.includes('...summarizeCounting(observations, {')
    const runDir = join(
      process.cwd(),
      'artifacts',
      'm6.1',
      'm6.1-wpinstr-20260923-88dba4e9e8e0-fbe1'
    )
    const observationPath = join(runDir, 'observations.partial.jsonl')
    const evidencePath = join(runDir, 'instrument-live.json')
    if (!existsSync(observationPath) || !existsSync(evidencePath)) return false
    const observations = readFileSync(observationPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { ok?: boolean; callFailure?: string | null })
    const lived = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      counting?: { stillFailedAfterRetries?: number }
    }
    const observed = observations as unknown as CountingObservation[]
    const summary = summarizeCounting(observed, {
      attempted: observed.length,
      judged: 0,
      baselineAttemptsPerItem: 2,
    })
    /*
     * 两件事一起断言：
     *   ① **历史那一轮**记录的 `stillFailedAfterRetries` 是 2 —— 那是**旧算法**的产物；
     *   ② 同一批观测喂进**出厂函数**，按新定义算出 `stillFailedAfterRetries = 0`、
     *      `withoutValidReading = 2`、原因全是 `semantic:`。
     * ⇒ 缺陷不是纸面上的：同一批数据，旧算法说"2 条失败"，新定义说"0 条传输失败"。
     */
    const defectDemonstrated =
      lived.counting?.stillFailedAfterRetries === 2 &&
      summary.stillFailedAfterRetries === 0 &&
      summary.withoutValidReading === 2 &&
      summary.noValidReadingByReason['semantic:alert_state_disagreement'] === 2
    return oldDerivationGone && splitThreeWays && defectDemonstrated
  })(),
  '传输失败 0 ≠ 没有有效读数 2'
)
check(
  '★ 负控（证据表达）：真正的传输失败 ⇒ 传输格必须记上、原因带 `transport:` 前缀（挡"两格是别名"）',
  (() => {
    /*
     * 只测正控不够：如果我把 `stillFailedAfterRetries` 直接写成 `withoutValidReading` 的别名，
     * 上面那条正控**照样会过**（因为那一轮传输失败恰好是 0）。
     * 这半用一个"全是传输失败"的合成形状把两者**逼开**：
     *   语义形状（真实证据） ⇒ 传输计数 0、无有效读数 2，**必须不相等**
     *   传输形状（这里注入） ⇒ 传输计数 2、无有效读数 2，**必须相等**
     * 只有"都按各自定义算"才能同时满足这两个方向。
     */
    const semantic: CountingObservation[] = [
      {
        ok: false,
        callFailure: null,
        parseFailure: 'alert_state_disagreement',
        attempts: 2,
        durationMs: 10,
      },
      {
        ok: false,
        callFailure: null,
        parseFailure: 'alert_state_disagreement',
        attempts: 2,
        durationMs: 10,
      },
    ]
    const transport: CountingObservation[] = [
      { ok: false, callFailure: 'timeout', parseFailure: null, attempts: 5, durationMs: 10 },
      { ok: true, callFailure: null, parseFailure: null, attempts: 2, durationMs: 10 },
    ]
    const semanticSummary = summarizeCounting(semantic, {
      attempted: 2,
      judged: 0,
      baselineAttemptsPerItem: 2,
    })
    const transportSummary = summarizeCounting(transport, {
      attempted: 2,
      judged: 1,
      baselineAttemptsPerItem: 2,
    })
    return (
      semanticSummary.stillFailedAfterRetries === 0 &&
      transportSummary.stillFailedAfterRetries === 1 &&
      transportSummary.withoutValidReading === 1 &&
      transportSummary.noValidReadingByReason['transport:timeout'] === 1 &&
      transportSummary.retriedItems === 1 &&
      transportSummary.judged === 1
    )
  })(),
  '两个方向都被逼开'
)

const perfect = runFixtureJudge(INSTRUMENT_ITEMS, fixturePerfectJudge())
check(
  '★ 正控：完美夹具 ⇒ 召回 1.0 / 误报 0.0 / 0 解析失败；判为 VALID（标准冻结时）',
  perfect.metrics.alert.recall === 1 &&
    perfect.metrics.nonAlert.rate === 0 &&
    perfect.metrics.parseFailures === 0 &&
    evaluateValidity(perfect.metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS }).verdict === 'VALID',
  `recall=${String(perfect.metrics.alert.recall)} falseAlarm=${String(perfect.metrics.nonAlert.rate)}`
)
check(
  '★ 负控：**标准未批准** ⇒ 再好的读数也只能 INCONCLUSIVE（"还没批的阈值"不能当通过）',
  evaluateValidity(perfect.metrics, INSTRUMENT_VALIDITY_CRITERIA, { criteriaFrozen: false }).verdict ===
    'INCONCLUSIVE',
  INSTRUMENT_VALIDITY_CRITERIA.status
)

const fakeJudges: { name: string; judge: () => ReturnType<typeof fixturePerfectJudge>; expect: string }[] = [
  /*
   * ⚠️ CD-11 之后这条期望**变了**，且新期望更准确：
   * 空断言集现在落到第三态（不可判定 / no_assertions），于是**可判分母为 0** ——
   * 而不是过去那个"召回率 0"。前者说的是"根本没有可判定的条目"，
   * 后者会被读成"判了但全漏了"，是两件事。
   */
  { name: '全部判安全（一条断言都不报）', judge: fixtureAlwaysSafeJudge, expect: 'no_alert_denominator' },
  { name: '全部判编造', judge: fixtureAlwaysAlertJudge, expect: 'false_alarm_above_max' },
  { name: '空结果（超时/空输出）', judge: fixtureEmptyJudge, expect: 'parse_failure_above_max' },
  { name: '形状坏掉（不是 JSON）', judge: fixtureGarbageJudge, expect: 'parse_failure_above_max' },
]
for (const sample of fakeJudges) {
  check(
    `★ 负控：${sample.name} ⇒ 判 INVALID 且给出 ${sample.expect}`,
    (() => {
      const run = runFixtureJudge(INSTRUMENT_ITEMS, sample.judge())
      const decision = evaluateValidity(run.metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
      return (
        decision.verdict === 'INVALID' &&
        decision.reasons.some((reason) => reason.code === sample.expect)
      )
    })(),
    (() => {
      const run = runFixtureJudge(INSTRUMENT_ITEMS, sample.judge())
      const decision = evaluateValidity(run.metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
      return `${decision.verdict}:${decision.reasons.map((r) => r.code).join(',')}`
    })()
  )
}
check(
  '★ 负控：**仅按关键词判** ⇒ 必须在支持性回忆上误报（复现立案里的"判错了对象"）',
  (() => {
    const run = runFixtureJudge(KEYWORD_CONTROL_ITEMS, fixtureKeywordJudge())
    const decision = evaluateValidity(run.metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
    return (
      decision.verdict === 'INVALID' &&
      run.metrics.nonAlert.falseAlarms === 1 &&
      decision.reasons.some((reason) => reason.code === 'false_alarm_above_max')
    )
  })(),
  (() => {
    const run = runFixtureJudge(KEYWORD_CONTROL_ITEMS, fixtureKeywordJudge())
    return `误报 ${String(run.metrics.nonAlert.falseAlarms)}/${String(run.metrics.nonAlert.total)} = ${String(run.metrics.nonAlert.rate)}`
  })()
)
check(
  '★ 恢复：把夹具放回完美判定器 ⇒ 同一套标准重新判 VALID（正控/负控/恢复三段齐了）',
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, fixturePerfectJudge())
    return evaluateValidity(run.metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS }).verdict === 'VALID'
  })(),
  '重新安静'
)

const zeroMetrics = computeMetrics(INSTRUMENT_ITEMS, [])
check(
  '★ 负控：一条判定都没有 ⇒ 分母 0 ⇒ recall/误报率必须是 **null**（不是 0、也不是 1）且判 INVALID',
  (() => {
    const decision = evaluateValidity(zeroMetrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
    return (
      zeroMetrics.alert.recall === null &&
      zeroMetrics.nonAlert.rate === null &&
      zeroMetrics.parseFailures === 0 &&
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'no_alert_denominator')
    )
  })(),
  `recall=${String(zeroMetrics.alert.recall)} 误报=${String(zeroMetrics.nonAlert.rate)} 判=${evaluateValidity(zeroMetrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS }).verdict}`
)
check(
  '★ 正控：逐类分母与混淆矩阵都给出（分母可见，不许只用总体准确率）',
  perfect.metrics.perCategory.length === 10 &&
    perfect.metrics.perLabel.length === MEMORY_ASSERTION_LABELS.length &&
    perfect.metrics.confusion.alertExpectedAlertPredicted === perfect.metrics.alert.total,
  `逐类 ${String(perfect.metrics.perCategory.length)} · 逐标签 ${String(perfect.metrics.perLabel.length)}`
)
check(
  '★ 正控：位置偏好如实记成 not-applicable（不是编一个数字），并给出两条等价防线读数',
  perfect.metrics.defenses.positionBias.status === 'not-applicable' &&
    perfect.metrics.defenses.aEqualsBConsistency.pairs >= 1 &&
    perfect.metrics.defenses.pairConsistency.pairs >= 3,
  `a==b ${String(perfect.metrics.defenses.aEqualsBConsistency.agree)}/${String(perfect.metrics.defenses.aEqualsBConsistency.pairs)} · 成对 ${String(perfect.metrics.defenses.pairConsistency.agree)}/${String(perfect.metrics.defenses.pairConsistency.pairs)}`
)
check(
  '★ 负控：让 a==b 的两条得到不同判定 ⇒ 必须报 a_equals_b_inconsistent',
  (() => {
    /*
     * 直接改**判定结果**，不走解析：这条测的是"度量层会不会发现逐字相同的两条被判得不一样"。
     * （若走解析注入一个越界标签，挡住它的是解析层而不是度量层 —— 那是另一条负控。）
     *
     * ⚠️ 目标条目**按 kind 找**而不是写死 id：第一版写死了 `contrast-ab-1b`，
     * 而这份夹具里的实际 id 是 `contrast-ab-1` / `contrast-ab-2` ⇒ 注入落空、
     * 负控"通过"了却什么都没测（一种最隐蔽的假绿：负控自己没生效）。
     */
    const targetId = INSTRUMENT_ITEMS.filter(
      (item) => item.contrast?.kind === 'a-equals-b'
    ).at(-1)?.itemId
    const judgments = INSTRUMENT_ITEMS.map((item) => {
      const base = judgeItem(item, fixturePerfectJudge()(item))
      if (targetId === undefined || item.itemId !== targetId) return base
      return { ...base, alertState: 'alert' as const, predictedAlert: true, predictedLabels: ['UNSUPPORTED_DETAIL'] }
    })
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const decision = evaluateValidity(metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
    return (
      targetId !== undefined &&
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'a_equals_b_inconsistent')
    )
  })(),
  (() => {
    const target = INSTRUMENT_ITEMS.filter((item) => item.contrast?.kind === 'a-equals-b').at(-1)
    const judgments = INSTRUMENT_ITEMS.map((item) => {
      const base = judgeItem(item, fixturePerfectJudge()(item))
      if (target === undefined || item.itemId !== target.itemId) return base
      return { ...base, alertState: 'alert' as const, predictedAlert: true, predictedLabels: ['UNSUPPORTED_DETAIL'] }
    })
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const decision = evaluateValidity(metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
    return `目标=${target?.itemId ?? '(未找到)'} ⇒ ${decision.reasons.map((reason) => reason.code).join(',')}`
  })()
)
check(
  '★ 恢复：不注入 ⇒ a==b 一致性回到 1.0、成对一致性回到 1.0',
  perfect.metrics.defenses.aEqualsBConsistency.rate === 1 &&
    perfect.metrics.defenses.pairConsistency.rate === 1,
  '重新安静'
)
check(
  '★ 负控：a==b 的一侧**传输失败** ⇒ 必须记成 incomplete，**不得**算成"不一致"（归因必须落在传输层）',
  (() => {
    const target = INSTRUMENT_ITEMS.filter((item) => item.contrast?.kind === 'a-equals-b').at(-1)
    if (target === undefined) return false
    const judgments = INSTRUMENT_ITEMS.map((item) =>
      item.itemId === target.itemId
        ? judgeItem(item, { ok: false, failure: 'empty', detail: '注入：传输失败' })
        : judgeItem(item, fixturePerfectJudge()(item))
    )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const ab = metrics.defenses.aEqualsBConsistency
    const codes = evaluateValidity(metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS }).reasons.map(
      (reason) => reason.code
    )
    return (
      ab.pairs === 0 &&
      ab.incomplete === 1 &&
      ab.rate === null &&
      !codes.includes('a_equals_b_inconsistent') &&
      codes.includes('a_equals_b_not_measured')
    )
  })(),
  (() => {
    const target = INSTRUMENT_ITEMS.filter((item) => item.contrast?.kind === 'a-equals-b').at(-1)
    if (target === undefined) return '(找不到 a==b 对)'
    const judgments = INSTRUMENT_ITEMS.map((item) =>
      item.itemId === target.itemId
        ? judgeItem(item, { ok: false, failure: 'empty', detail: '注入：传输失败' })
        : judgeItem(item, fixturePerfectJudge()(item))
    )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const ab = metrics.defenses.aEqualsBConsistency
    return `pairs=${String(ab.pairs)} incomplete=${String(ab.incomplete)} rate=${String(ab.rate)} ⇒ ${
      evaluateValidity(metrics, FROZEN_CRITERIA, { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS })
        .reasons.map((reason) => reason.code)
        .join(',') || '(没响)'
    }`
  })()
)
check(
  '★ 恢复：把传输失败放回去 ⇒ a==b 重新可测且一致',
  (() => {
    const metrics = computeMetrics(INSTRUMENT_ITEMS, perfect.judgments)
    const ab = metrics.defenses.aEqualsBConsistency
    return ab.pairs === 1 && ab.incomplete === 0 && ab.rate === 1
  })(),
  '重新安静'
)

// ---- CD-8：跨轮稳定性（**加强**判据；把已观察到的缺陷变成门）----
check(
  '★ 正控（CD-8）：探针 k 次全一致 ⇒ 稳定性判据安静（1.0，0 条理由）',
  DET_STABILITY.rate === 1 &&
    DET_STABILITY.alertProbes === 3 &&
    DET_STABILITY.nonAlertProbes === 3 &&
    evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY, crossRun: DET_CROSS,
    }).reasons.length === 0,
  `rate=${String(DET_STABILITY.rate)} 探针=${String(DET_STABILITY.probeItems)}（警 ${String(DET_STABILITY.alertProbes)}/控 ${String(DET_STABILITY.nonAlertProbes)}）`
)
check(
  '★ 负控（CD-8）：某一项 k 次不一致 ⇒ 必须报 stability_below_min 并具名那一项',
  (() => {
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: FLAP_STABILITY,
    })
    return (
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'stability_below_min') &&
      FLAP_STABILITY.disagreements.length === 1
    )
  })(),
  (() => {
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: FLAP_STABILITY,
    })
    return `${String(FLAP_STABILITY.agreeingItems)}/${String(FLAP_STABILITY.probeItems)} ⇒ ${decision.reasons.map((r) => r.code).join(',')}`
  })()
)
check(
  '★ 负控（CD-8）：**没跑探针** ⇒ 必须报 stability_not_measured（"没测到"≠"通过了"）',
  (() => {
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, { criteriaFrozen: true })
    return (
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'stability_not_measured')
    )
  })(),
  '拒绝把"没测"算成"通过"'
)
check(
  '★ 负控（CD-8）：探针只覆盖一个方向 ⇒ 必须报 stability_probe_one_sided',
  (() => {
    const oneSided = computeStability(
      INSTRUMENT_ITEMS.filter((item) => !item.expectedAlert)
        .slice(0, 6)
        .map((item) => ({
          itemId: item.itemId,
          expectedAlert: false,
          samples: [item.expectedLabels.slice(0, 1), item.expectedLabels.slice(0, 1), item.expectedLabels.slice(0, 1)].map((labels) => ({ ok: true, labels })),
        }))
    )
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: oneSided,
    })
    return decision.reasons.some((reason) => reason.code === 'stability_probe_one_sided')
  })(),
  '只覆盖一侧不算证据'
)
check(
  '★ 恢复（CD-8）：放回确定的探针 ⇒ 稳定性判据重新安静',
  evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
    criteriaFrozen: true,
    stability: DET_STABILITY, crossRun: DET_CROSS,
  }).verdict === 'VALID',
  '重新安静'
)
check(
  '★ 负控（CD-8）：采样次数不足 k ⇒ 也必须响（一致性不能靠"只采一次"白拿）',
  (() => {
    const onlyOnce = computeStability(
      [
        ...INSTRUMENT_ITEMS.filter((item) => item.expectedAlert).slice(0, 3),
        ...INSTRUMENT_ITEMS.filter((item) => !item.expectedAlert).slice(0, 3),
      ].map((item) => ({
        itemId: item.itemId,
        expectedAlert: item.expectedAlert,
        samples: [item.expectedLabels.slice(0, 1)].map((labels) => ({ ok: true, labels })),
      }))
    )
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: onlyOnce,
    })
    return (
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'stability_below_min')
    )
  })(),
  '每项只采样 1 次 ⇒ 不算稳定性证据'
)

check(
  '★ 负控（CD-8）：某个探针项的采样**失败** ⇒ 必须记 incomplete，**不得**算成"不一致"',
  (() => {
    /*
     * 这是本阶段同一类归因错误的**第三次**：失败采样的标签集是空的，
     * 直接拿去比就会把传输故障报成语义不一致。这里把"必须分开归因"钉住。
     */
    const picked = [
      ...INSTRUMENT_ITEMS.filter((item) => item.expectedAlert).slice(0, 3),
      ...INSTRUMENT_ITEMS.filter((item) => !item.expectedAlert).slice(0, 3),
    ]
    const reading = computeStability(
      picked.map((item, index) => ({
        itemId: item.itemId,
        expectedAlert: item.expectedAlert,
        samples: [
          { ok: true, labels: item.expectedLabels.slice(0, 1) },
          { ok: index !== 0, labels: index === 0 ? [] : item.expectedLabels.slice(0, 1) },
          { ok: true, labels: item.expectedLabels.slice(0, 1) },
        ],
      }))
    )
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: reading,
    })
    return (
      reading.notMeasuredItems === 1 &&
      reading.measuredItems === 5 &&
      reading.disagreements.length === 0 &&
      reading.rate === 1 &&
      !decision.reasons.some((reason) => reason.code === 'stability_below_min') &&
      decision.reasons.some((reason) => reason.code === 'stability_samples_incomplete')
    )
  })(),
  (() => {
    const picked = [
      ...INSTRUMENT_ITEMS.filter((item) => item.expectedAlert).slice(0, 3),
      ...INSTRUMENT_ITEMS.filter((item) => !item.expectedAlert).slice(0, 3),
    ]
    const reading = computeStability(
      picked.map((item, index) => ({
        itemId: item.itemId,
        expectedAlert: item.expectedAlert,
        samples: [
          { ok: true, labels: item.expectedLabels.slice(0, 1) },
          { ok: index !== 0, labels: index === 0 ? [] : item.expectedLabels.slice(0, 1) },
          { ok: true, labels: item.expectedLabels.slice(0, 1) },
        ],
      }))
    )
    return `measured=${String(reading.measuredItems)} notMeasured=${String(reading.notMeasuredItems)} rate=${String(reading.rate)} 不一致=${String(reading.disagreements.length)}`
  })()
)
check(
  '★ 负控（CD-14 · CD-8）：k 次**都拿到了但都没给结论** ⇒ 不算稳定通过（也不许算成"一致"）',
  (() => {
    /*
     * 这是 CD-14 新加的一层：旧口径下"k 次标签集合都是空"会**看起来一致**，
     * 于是"没测到"被写成"稳定"——方向恰好反了。
     */
    const decision = evaluateValidity(perfect.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: ALL_UNDECIDABLE_STABILITY,
    })
    return (
      ALL_UNDECIDABLE_STABILITY.measuredItems === 0 &&
      ALL_UNDECIDABLE_STABILITY.agreeingItems === 0 &&
      ALL_UNDECIDABLE_STABILITY.undecidableItems.length === ALL_UNDECIDABLE_STABILITY.probeItems &&
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'stability_not_conclusive') &&
      !decision.reasons.some((reason) => reason.code === 'stability_below_min')
    )
  })(),
  `measured=${String(ALL_UNDECIDABLE_STABILITY.measuredItems)} 不可判=${String(ALL_UNDECIDABLE_STABILITY.undecidableItems.length)}`
)


// ---- CD-9：跨轮稳定性（补 CD-8 覆盖不到的慢漂移）----
const CROSS_CONFIG = 'test-config@1'
function crossSamples(runId: string, labelsByItem: Record<string, string[]>): CrossRunSample[] {
  return Object.entries(labelsByItem).map(([itemId, labels]) => ({
    runId,
    itemId,
    configKey: CROSS_CONFIG,
    labels,
  }))
}
const SIX_ITEMS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
const CROSS_PRIOR = crossSamples(
  'run-old',
  Object.fromEntries(SIX_ITEMS.map((id) => [id, ['SUPPORTED_RECALL']]))
)
const CROSS_CURRENT_SAME = crossSamples(
  'run-new',
  Object.fromEntries(SIX_ITEMS.map((id) => [id, ['SUPPORTED_RECALL']]))
)
/*
 * ⚠️ `CD-14`：漂移必须是**三态的漂移**。第一版让 p3 从 `SUPPORTED_RECALL` 变成
 * `CURRENT_DISCLOSURE` —— 两者**都是不报警**，在新口径下它们**一致**，
 * 于是负控什么都没测到（负控自己失效是最隐蔽的假绿）。现在改成 不报警 → 报警。
 */
const CROSS_CURRENT_DRIFTED = crossSamples(
  'run-new',
  Object.fromEntries(
    SIX_ITEMS.map((id) => [id, id === 'p3' ? ['UNSUPPORTED_DETAIL'] : ['SUPPORTED_RECALL']])
  )
)
const CROSS_CURRENT_DRIFTED_FINE_ONLY = crossSamples(
  'run-new',
  Object.fromEntries(
    SIX_ITEMS.map((id) => [id, id === 'p3' ? ['CURRENT_DISCLOSURE'] : ['SUPPORTED_RECALL']])
  )
)

check(
  '★ 正控（CD-9）：历轮与本轮标签一致 ⇒ 跨轮判据安静（6/6，0 条理由）',
  (() => {
    const reading = computeCrossRunStability(CROSS_PRIOR, CROSS_CURRENT_SAME, CROSS_CONFIG)
    return (
      reading.comparedItems === 6 &&
      reading.agreeingItems === 6 &&
      reading.rate === 1 &&
      evaluateCrossRun(reading, FROZEN_CRITERIA).length === 0
    )
  })(),
  '跨轮一致'
)
check(
  '★ 负控（CD-9）：某一项**跨轮**给出不同标签 ⇒ 必须报 cross_run_instability 并具名那一项',
  (() => {
    const reading = computeCrossRunStability(CROSS_PRIOR, CROSS_CURRENT_DRIFTED, CROSS_CONFIG)
    const codes = evaluateCrossRun(reading, FROZEN_CRITERIA).map((reason) => reason.code)
    return (
      reading.rate !== 1 &&
      reading.disagreements.length === 1 &&
      reading.disagreements[0]?.itemId === 'p3' &&
      codes.includes('cross_run_instability')
    )
  })(),
  (() => {
    const reading = computeCrossRunStability(CROSS_PRIOR, CROSS_CURRENT_DRIFTED, CROSS_CONFIG)
    return `${String(reading.agreeingItems)}/${String(reading.comparedItems)} ⇒ ${evaluateCrossRun(reading, FROZEN_CRITERIA).map((r) => r.code).join(',')}`
  })()
)
check(
  '★ 负控（CD-9）：**没有历史** ⇒ 必须报 cross_run_history_too_short（单轮无法证明可复现）',
  (() => {
    const reading = computeCrossRunStability([], CROSS_CURRENT_SAME, CROSS_CONFIG)
    const codes = evaluateCrossRun(reading, FROZEN_CRITERIA).map((reason) => reason.code)
    return reading.priorItems === 0 && codes.includes('cross_run_history_too_short')
  })(),
  'INCONCLUSIVE 是正确行为，不是失败'
)
check(
  '★ 负控（CD-9）：历史配置不同 ⇒ 采样**不合并**（excludedByConfig 计数，比对数不受污染）',
  (() => {
    const wrongConfig = CROSS_PRIOR.map((sample) => ({ ...sample, configKey: 'other@9' }))
    const reading = computeCrossRunStability(wrongConfig, CROSS_CURRENT_SAME, CROSS_CONFIG)
    return (
      reading.excludedByConfig === 6 &&
      reading.priorItems === 0 &&
      reading.comparedItems === 0
    )
  })(),
  '不把不同配置的片段拼成一份读数'
)
check(
  '★ 正控（CD-14 · CD-9）：跨轮**只**换了细标签（三态相同）⇒ 跨轮判据保持安静（细标签是诊断）',
  (() => {
    const reading = computeCrossRunStability(
      CROSS_PRIOR,
      CROSS_CURRENT_DRIFTED_FINE_ONLY,
      CROSS_CONFIG
    )
    return (
      reading.comparedItems === 6 &&
      reading.agreeingItems === 6 &&
      evaluateCrossRun(reading, FROZEN_CRITERIA).length === 0
    )
  })(),
  '细标签漂移不算跨轮不稳定'
)
check(
  '★ 负控（CD-14 · CD-9）：跨轮**三态**变了（不报警 → 报警）⇒ 必须报 cross_run_instability',
  (() => {
    const reading = computeCrossRunStability(CROSS_PRIOR, CROSS_CURRENT_DRIFTED, CROSS_CONFIG)
    return (
      reading.disagreements.length === 1 &&
      reading.disagreements[0]?.itemId === 'p3' &&
      evaluateCrossRun(reading, FROZEN_CRITERIA).some((r) => r.code === 'cross_run_instability')
    )
  })(),
  '三态漂移才算跨轮不稳定'
)
check(
  '★ 恢复（CD-9）：放回一致的历史 ⇒ 跨轮判据重新安静',
  evaluateCrossRun(
    computeCrossRunStability(CROSS_PRIOR, CROSS_CURRENT_SAME, CROSS_CONFIG),
    FROZEN_CRITERIA
  ).length === 0,
  '重新安静'
)

// ---- CD-10：一条读数 = 两次一致；不一致进分母且**单独归因** ----
check(
  '★ 正控（CD-10）：没有 UNRESOLVED ⇒ 该判据安静，且 unresolvedRate 恰为 0（不是 null）',
  (() => {
    const metrics = computeMetrics(INSTRUMENT_ITEMS, perfect.judgments)
    return (
      metrics.unresolved === 0 &&
      metrics.unresolvedRate === 0 &&
      evaluateValidity(metrics, FROZEN_CRITERIA, {
        criteriaFrozen: true,
        stability: DET_STABILITY,
        crossRun: DET_CROSS,
      }).reasons.every((reason) => reason.code !== 'unresolved_above_max')
    )
  })(),
  '安静'
)
check(
  '★ 负控（CD-10）：注入若干"两次不一致"⇒ 必须报 unresolved_above_max，且**不得**混进 parseFailures',
  (() => {
    /*
     * 这条同时钉住**归因**：UNRESOLVED 是语义（判两次不一致），
     * parseFailures 是传输/解析。混起来就是本阶段犯过多次的那类错。
     */
    const make = (): typeof perfect.judgments =>
      INSTRUMENT_ITEMS.map((item, index) =>
        index < 6
          ? {
              itemId: item.itemId,
              ok: false,
              failure: 'alert_state_disagreement' as const,
              alertState: 'undecidable' as const,
              predictedAlert: false,
              predictedLabels: [],
              expectedAlert: item.expectedAlert,
              expectedLabels: item.expectedLabels,
            }
          : judgeItem(item, fixturePerfectJudge()(item))
      )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, make())
    const codes = evaluateValidity(metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY,
      crossRun: DET_CROSS,
    }).reasons.map((reason) => reason.code)
    return (
      metrics.unresolved === 6 &&
      metrics.parseFailures === 0 &&
      (metrics.unresolvedRate ?? 0) > FROZEN_CRITERIA.maxUnresolvedRate &&
      codes.includes('unresolved_above_max') &&
      !codes.includes('parse_failure_above_max')
    )
  })(),
  (() => {
    const make = (): typeof perfect.judgments =>
      INSTRUMENT_ITEMS.map((item, index) =>
        index < 6
          ? {
              itemId: item.itemId,
              ok: false,
              failure: 'alert_state_disagreement' as const,
              alertState: 'undecidable' as const,
              predictedAlert: false,
              predictedLabels: [],
              expectedAlert: item.expectedAlert,
              expectedLabels: item.expectedLabels,
            }
          : judgeItem(item, fixturePerfectJudge()(item))
      )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, make())
    return `unresolved=${String(metrics.unresolved)} parseFailures=${String(metrics.parseFailures)} rate=${String(metrics.unresolvedRate)}`
  })()
)
check(
  '★ 负控（归因拆分）：某类的应报警条目**全被判失败** ⇒ 报 transport_lost，**不是** without_alert_control',
  (() => {
    /*
     * 本阶段第五个归因变体：第一版只报 `category_without_alert_control`，
     * 于是"截断掉光了某类的报警条目"被读成"语料缺正控"——处置完全不同。
     */
    const target = INSTRUMENT_ITEMS.find((item) => item.expectedAlert)
    if (target === undefined) return false
    const judgments = INSTRUMENT_ITEMS.map((item) =>
      item.category === target.category
        ? {
            itemId: item.itemId,
            ok: false,
            failure: 'empty' as const,
            alertState: 'undecidable' as const,
            predictedAlert: false,
            predictedLabels: [],
            expectedAlert: item.expectedAlert,
            expectedLabels: item.expectedLabels,
          }
        : judgeItem(item, fixturePerfectJudge()(item))
    )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const codes = evaluateValidity(metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY,
      crossRun: DET_CROSS,
    }).reasons.map((reason) => reason.code)
    const entry = metrics.perCategory.find((row) => row.category === target.category)
    return (
      entry !== undefined &&
      entry.alertDeclared > 0 &&
      entry.alertExpected === 0 &&
      codes.includes('category_alert_control_transport_lost') &&
      !codes.includes('category_without_alert_control')
    )
  })(),
  (() => {
    const target = INSTRUMENT_ITEMS.find((item) => item.expectedAlert)
    return target === undefined ? '(找不到应报警条目)' : `目标类别 ${target.category}`
  })()
)
check(
  '★ 负控（归因拆分②）：某类的应报警条目**全因语义分歧不可判** ⇒ 必须报 unjudged 而**不是** transport_lost',
  (() => {
    /*
     * 实测逼出来的第五例归因偏转（`…-313d` 那轮）：类别 H 的两条应报警条目
     * 都是 `unresolved`（同一次采样给出两种标签集合），而报告写着
     * "被传输失败吃掉、根因在传输层" —— 处置完全不同（一个重跑，一个改提示）。
     * 这条断言把"按原因分流"钉住：语义类原因 ⇒ 不许说传输。
     */
    const target = INSTRUMENT_ITEMS.find((item) => item.expectedAlert)
    if (target === undefined) return false
    const judgments = INSTRUMENT_ITEMS.map((item) =>
      item.category === target.category && item.expectedAlert
        ? {
            itemId: item.itemId,
            ok: false,
            failure: 'alert_state_disagreement' as const,
            alertState: 'undecidable' as const,
            predictedAlert: false,
            predictedLabels: [],
            expectedAlert: item.expectedAlert,
            expectedLabels: item.expectedLabels,
          }
        : judgeItem(item, fixturePerfectJudge()(item))
    )
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const codes = evaluateValidity(metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY,
      crossRun: DET_CROSS,
    }).reasons.map((reason) => reason.code)
    const entry = metrics.perCategory.find((row) => row.category === target.category)
    return (
      entry !== undefined &&
      entry.alertExpected === 0 &&
      (entry.lostAlertReasons.alert_state_disagreement ?? 0) > 0 &&
      codes.includes('category_alert_control_unjudged') &&
      !codes.includes('category_alert_control_transport_lost')
    )
  })(),
  '语义层丢失不许说成传输层'
)
check(
  '★ 正控（归因拆分②·恢复）：同一类换成**传输失败** ⇒ 回到 transport_lost（分流没有把两边都说成 unjudged）',
  (() => {
    const target = INSTRUMENT_ITEMS.find((item) => item.expectedAlert)
    if (target === undefined) return false
    const judgments = INSTRUMENT_ITEMS.map((item) =>
      item.category === target.category && item.expectedAlert
        ? {
            itemId: item.itemId,
            ok: false,
            failure: 'empty' as const,
            alertState: 'undecidable' as const,
            predictedAlert: false,
            predictedLabels: [],
            expectedAlert: item.expectedAlert,
            expectedLabels: item.expectedLabels,
          }
        : judgeItem(item, fixturePerfectJudge()(item))
    )
    const codes = evaluateValidity(
      computeMetrics(INSTRUMENT_ITEMS, judgments),
      FROZEN_CRITERIA,
      { criteriaFrozen: true, stability: DET_STABILITY, crossRun: DET_CROSS }
    ).reasons.map((reason) => reason.code)
    return (
      codes.includes('category_alert_control_transport_lost') &&
      !codes.includes('category_alert_control_unjudged')
    )
  })(),
  '传输层丢失仍说传输层'
)

// ===========================================================================
section('§7 可判覆盖率：专门负控（**不依赖** minDecidableRate 是否被批准）')
// ===========================================================================

/*
 * 这四条负控靠的是**已经冻结的**判据（"可判分母为 0" 与 "召回为 0"），
 * 因此不必等覆盖率阈值裁定就能钉住。夹具直接定义在本文件里 ——
 * 它们是**测试用**的假判定器，不该混进 instrument.ts 的公开夹具集合。
 */
const judgeAllIndeterminate = (): { ok: true; output: { assertions: { quote: string; label: string }[] } } => ({
  ok: true,
  output: { assertions: [{ quote: '(夹具)', label: 'INDETERMINATE' }] },
})
const judgeAllExplicitSafe = (): { ok: true; output: { assertions: { quote: string; label: string }[] } } => ({
  ok: true,
  output: { assertions: [{ quote: '(夹具)', label: 'APPROPRIATE_UNCERTAINTY' }] },
})
/** 难样本（应报警）全部失败、简单样本（不应报警）全部判对 */
const judgeHardFailEasyPass = (item: InstrumentItem) =>
  item.expectedAlert
    ? ({ ok: false as const, failure: 'empty' as const, detail: '夹具：难样本全部失败' })
    : ({
        ok: true as const,
        output: {
          assertions: [
            { quote: '(夹具)', label: item.expectedLabels[0] ?? 'APPROPRIATE_UNCERTAINTY' },
          ],
        },
      })

check(
  '★ 负控①：全部输出**显式 INDETERMINATE** ⇒ 可判分母为 0 ⇒ 不许 VALID',
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, judgeAllIndeterminate)
    const codes = evaluateValidity(run.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY,
      crossRun: DET_CROSS,
    }).reasons.map((reason) => reason.code)
    return (
      run.metrics.denominators.decidable === 0 &&
      run.metrics.denominators.decidableRate === 0 &&
      run.metrics.undecidable === INSTRUMENT_ITEMS.length &&
      codes.includes('no_alert_denominator') &&
      codes.includes('no_non_alert_denominator')
    )
  })(),
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, judgeAllIndeterminate)
    return `decidable=${String(run.metrics.denominators.decidable)} undecidableByReason=${JSON.stringify(run.metrics.undecidableByReason)}`
  })()
)
check(
  '★ 负控②：全部**空断言集** ⇒ 同样无可判分母（**与 ① 分开**：一个"明确弃判"、一个"没给断言"）',
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, fixtureAlwaysSafeJudge())
    return (
      run.metrics.denominators.decidable === 0 &&
      (run.metrics.undecidableByReason.undecidable_both_samples ?? 0) === INSTRUMENT_ITEMS.length &&
      run.metrics.noAssertionVerdicts === INSTRUMENT_ITEMS.length
    )
  })(),
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, fixtureAlwaysSafeJudge())
    return `undecidable_both_samples=${String(run.metrics.undecidableByReason.undecidable_both_samples)} 空断言=${String(run.metrics.noAssertionVerdicts)}`
  })()
)
check(
  '★ 负控③：**难样本全部失败 + 简单样本全部判对** ⇒ 应报警类可判数为 0 ⇒ 不许靠可判子集的高分取得 VALID',
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, judgeHardFailEasyPass)
    const decision = evaluateValidity(run.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY,
      crossRun: DET_CROSS,
    })
    return (
      run.metrics.denominators.decidableAlert === 0 &&
      run.metrics.denominators.decidableNonAlert > 0 &&
      decision.verdict === 'INVALID' &&
      decision.reasons.some((reason) => reason.code === 'no_alert_denominator')
    )
  })(),
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, judgeHardFailEasyPass)
    return `可判报警=${String(run.metrics.denominators.decidableAlert)} 可判不报警=${String(run.metrics.denominators.decidableNonAlert)} 可判率=${String(run.metrics.denominators.decidableRate)}`
  })()
)
check(
  '★ 边界④：全部**明确**判不报警（有标签、可判）⇒ 不是"无分母"，而是**召回 0** ⇒ 因漏报被拒',
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, judgeAllExplicitSafe)
    const codes = evaluateValidity(run.metrics, FROZEN_CRITERIA, {
      criteriaFrozen: true,
      stability: DET_STABILITY,
      crossRun: DET_CROSS,
    }).reasons.map((reason) => reason.code)
    return (
      run.metrics.denominators.decidable === INSTRUMENT_ITEMS.length &&
      run.metrics.denominators.decidableRate === 1 &&
      run.metrics.alert.recall === 0 &&
      codes.includes('alert_recall_below_min') &&
      !codes.includes('no_alert_denominator')
    )
  })(),
  (() => {
    const run = runFixtureJudge(INSTRUMENT_ITEMS, judgeAllExplicitSafe)
    return `可判率=${String(run.metrics.denominators.decidableRate)} 召回=${String(run.metrics.alert.recall)}`
  })()
)
check(
  '★ 边界⑤：**"明确判不报警"与"不可判定"是两种状态**（可判数 N vs 0）；而"空断言"与"显式 INDETERMINATE"是**同一不可判状态的两个原因**',
  (() => {
    /*
     * ⚠️ 这条的措辞被更正过：第一版写成"三态互斥：明确不报警 / 空断言 / 显式 INDETERMINATE
     * 得到三个不同的可判数" —— 把**同一状态的两个原因**说成了两种状态。
     * 三态始终是 报警 / 不报警 / 不可判定；后两者都属第三态，只是 reason 不同。
     */
    const explicitSafe = runFixtureJudge(INSTRUMENT_ITEMS, judgeAllExplicitSafe).metrics
    const emptyAssertion = runFixtureJudge(INSTRUMENT_ITEMS, fixtureAlwaysSafeJudge()).metrics
    const indeterminate = runFixtureJudge(INSTRUMENT_ITEMS, judgeAllIndeterminate).metrics
    return (
      // 状态之别：明确判不报警 ⇒ 全部可判；两种不可判夹具 ⇒ 可判数都是 0（**同一个 0**）
      explicitSafe.denominators.decidable === INSTRUMENT_ITEMS.length &&
      emptyAssertion.denominators.decidable === 0 &&
      indeterminate.denominators.decidable === 0 &&
      // 原因之别：同一个"不可判定"状态，reason 键不同
      (emptyAssertion.undecidableByReason.undecidable_both_samples ?? 0) === INSTRUMENT_ITEMS.length &&
      emptyAssertion.noAssertionVerdicts === INSTRUMENT_ITEMS.length &&
      (indeterminate.undecidableByReason.undecidable_both_samples ?? 0) === INSTRUMENT_ITEMS.length &&
      indeterminate.noAssertionVerdicts === 0
    )
  })(),
  '明确不报警 = 可判状态；空断言与 INDETERMINATE 同属不可判定状态、原因不同'
)

// ---- CD-12：可判覆盖率门（用户 2026-09-23 授权按 0.90 冻结）----
const undecideSome = (count: number) =>
  INSTRUMENT_ITEMS.map((item, index) =>
    index < count
      ? {
          itemId: item.itemId,
          ok: false as const,
          failure: 'alert_state_disagreement' as const,
          alertState: 'undecidable' as const,
          predictedAlert: false,
          predictedLabels: [],
          expectedAlert: item.expectedAlert,
          expectedLabels: item.expectedLabels,
        }
      : judgeItem(item, fixturePerfectJudge()(item))
  )
const codesWithCoverage = (judgments: ReturnType<typeof undecideSome>): string[] =>
  evaluateValidity(computeMetrics(INSTRUMENT_ITEMS, judgments), FROZEN_CRITERIA, {
    criteriaFrozen: true,
    stability: DET_STABILITY,
    crossRun: DET_CROSS,
  }).reasons.map((reason) => reason.code)

check(
  '★ 正控（CD-12）：覆盖率 1.0 ⇒ 三条覆盖门全部安静',
  (() => {
    const codes = codesWithCoverage(perfect.judgments)
    return !codes.some((code) => code.startsWith('decidable_') || code.includes('rate_below_min'))
  })(),
  '安静'
)
check(
  '★ 负控⑤（用户点名）：**少量困难样本不可判、两类可判分母都非零、可判子集成绩满分** ⇒ 仍必须因**覆盖不足**被拒',
  (() => {
    /*
     * 这条是专门用来证明**覆盖门本身有效**的：
     * 之前的"应报警可判数为 0"只证明了**零分母保护** —— 分母非零时那条根本不会响。
     * 这里 10/68 = 0.853 < 0.90，而可判子集召回 1.0、误报 0 ⇒ 唯一的拦截者只能是覆盖率判据。
     */
    const judgments = undecideSome(10)
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    const codes = codesWithCoverage(judgments)
    return (
      metrics.denominators.decidableAlert > 0 &&
      metrics.denominators.decidableNonAlert > 0 &&
      metrics.alert.recall === 1 &&
      metrics.nonAlert.rate === 0 &&
      codes.includes('decidable_rate_below_min')
    )
  })(),
  (() => {
    const judgments = undecideSome(10)
    const metrics = computeMetrics(INSTRUMENT_ITEMS, judgments)
    return `覆盖率=${String(metrics.denominators.decidable)}/${String(metrics.denominators.declared)} 召回=${String(metrics.alert.recall)} 误报=${String(metrics.nonAlert.rate)} ⇒ ${codesWithCoverage(judgments).join(',')}`
  })()
)
check(
  '★ 边界（CD-12）：应报警覆盖率**恰好 0.90** ⇒ 通过；**少一条原始计数** ⇒ 必须拒（不用四舍五入显示值）',
  (() => {
    /*
     * 语料声明应报警 30 条 ⇒ 让它恰好 3 条不可判 = 27/30 = **0.90**（落在阈值上）
     * ⇒ 必须通过；4 条不可判 = 26/30 = 0.867 ⇒ 必须拒。
     * 这条同时是"**用原始计数**比较"的验证：0.867 与 0.90 的四舍五入显示值可能都是 0.9 附近，
     * 只有整数比较能稳定区分。
     */
    const undecideFirstAlertItems = (count: number) => {
      const alertIndexes = INSTRUMENT_ITEMS.map((item, index) =>
        item.expectedAlert ? index : -1
      ).filter((index) => index >= 0)
      const chosen = new Set(alertIndexes.slice(0, count))
      return INSTRUMENT_ITEMS.map((item, index) =>
        chosen.has(index)
          ? {
              itemId: item.itemId,
              ok: false as const,
              failure: 'alert_state_disagreement' as const,
              alertState: 'undecidable' as const,
              predictedAlert: false,
              predictedLabels: [],
              expectedAlert: item.expectedAlert,
              expectedLabels: item.expectedLabels,
            }
          : judgeItem(item, fixturePerfectJudge()(item))
      )
    }
    const atBoundary = codesWithCoverage(undecideFirstAlertItems(3))
    const belowBoundary = codesWithCoverage(undecideFirstAlertItems(4))
    return (
      !atBoundary.includes('decidable_alert_rate_below_min') &&
      belowBoundary.includes('decidable_alert_rate_below_min')
    )
  })(),
  '恰好 0.90 通过；再少一条即拒'
)
check(
  '★ 恢复（CD-12）：回到全覆盖 ⇒ 三条覆盖门重新安静',
  !codesWithCoverage(perfect.judgments).includes('decidable_rate_below_min'),
  '重新安静'
)
check(
  '★ 负控（CD-12）：每类别可判控制数 —— 某类可判应报警只剩 1 条 ⇒ 必须报 category_decidable_control_below_min',
  (() => {
    const target = INSTRUMENT_ITEMS.find((item) => item.expectedAlert)
    if (target === undefined) return false
    const codes = codesWithCoverage(
      INSTRUMENT_ITEMS.map((item, index) =>
        item.category === target.category && item.expectedAlert && index > 0
          ? {
              itemId: item.itemId,
              ok: false as const,
              failure: 'alert_state_disagreement' as const,
              alertState: 'undecidable' as const,
              predictedAlert: false,
              predictedLabels: [],
              expectedAlert: item.expectedAlert,
              expectedLabels: item.expectedLabels,
            }
          : judgeItem(item, fixturePerfectJudge()(item))
      )
    )
    return codes.includes('category_decidable_control_below_min')
  })(),
  '整体通过不能掩盖某一类别不可测'
)

// ===========================================================================
// 只读读数：真实库 mtime 扫描器（新量具 ⇒ 按 §6.7 走三段式）
// ===========================================================================
//
// 计划书 §6.3 要求每次运行前后记"真实库摘要**与 mtime**"。这里守的是 mtime 那半边：
// 它只 `readdir` + `stat`，**不打开数据库**。⚠️ 对着**真函数**测（不是抄一份逻辑）——
// 抄一份就等于"量具测了错的对象"。
section('只读读数：真实库 mtime 扫描器（正控 / 负控 / 恢复）')
{
  const dir = mkdtempSync(join(tmpdir(), 'm6.1-mtime-'))
  const aFile = join(dir, 'a.txt')
  const bFile = join(dir, 'b.txt')
  writeFileSync(aFile, 'a', 'utf8')
  writeFileSync(bFile, 'b', 'utf8')
  /*
   * ⚠️ 用**显式时间戳**，不靠"刚写完就算新"：同一毫秒内写两个文件时，
   *    按 mtime 分不出谁更新，测试会变成靠运气。
   */
  const tA = new Date('2026-01-01T00:00:00Z')
  const tB = new Date('2026-01-02T00:00:00Z')
  utimesSync(aFile, tA, tA)
  utimesSync(bFile, tB, tB)

  /* ---- 正控：合法输入 ⇒ 读数指向"更新"的那个文件 ---- */
  const positive = newestMtimeMs(dir)
  check(
    '★ 正控（mtime 扫描器）：两个文件、最新的是 b.txt',
    positive.files === 2 && positive.newestPath === 'b.txt' && positive.newestMtimeMs === tB.getTime(),
    `files=${String(positive.files)} newest=${positive.newestPath}`
  )

  /* ---- 负控①：把 a 变新 ⇒ 读数**必须**跟着改（否则它根本没在看） ---- */
  const tA2 = new Date('2026-01-03T00:00:00Z')
  utimesSync(aFile, tA2, tA2)
  const negative = newestMtimeMs(dir)
  check(
    '★ 负控（mtime 扫描器）：把 a.txt 变新之后，读数必须改指 a.txt',
    negative.newestPath === 'a.txt' && negative.newestMtimeMs === tA2.getTime(),
    `newest=${negative.newestPath} mtimeMs=${String(negative.newestMtimeMs)}`
  )

  /* ---- 负控②：空目录 ⇒ **必须**报 MEASUREMENT INVALID（"没测到"≠"没变化"） ---- */
  const emptyDir = mkdtempSync(join(tmpdir(), 'm6.1-mtime-empty-'))
  let threw = false
  try {
    newestMtimeMs(emptyDir)
  } catch {
    threw = true
  }
  check('★ 负控（mtime 扫描器）：空目录必须抛错（measured_count = 0 不是"没变化"）', threw)

  /* ---- 恢复：把 b 再变新 ⇒ 读数回到 b（说明前两段是"被注入的状态"，不是它坏了） ---- */
  const tB2 = new Date('2026-01-04T00:00:00Z')
  utimesSync(bFile, tB2, tB2)
  const recovery = newestMtimeMs(dir)
  check(
    '★ 恢复（mtime 扫描器）：把 b.txt 再变新 ⇒ 读数回到 b.txt',
    recovery.newestPath === 'b.txt' && recovery.newestMtimeMs === tB2.getTime(),
    `newest=${recovery.newestPath}`
  )

  rmSync(dir, { recursive: true, force: true })
  rmSync(emptyDir, { recursive: true, force: true })
}

// ===========================================================================
// 「生产装配 ≡ 受测装配」静态判据（M6.1 WP4 / ADR-055 D-55d）
// ===========================================================================
//
// 它防的是一处**真实发生过**的缺陷：旧 `evals/m3/runtime/host.ts` 自己 new 网关，
// 少接了 memoryWriter / recall / rollup / actionWriter，而所有门都是绿的。
// 三段式：正控（当前树必须安静）· 三条负控（各一类缺陷必须**因预期原因**报红）· 恢复。
section('装配等价判据（正控 / 三条负控 / 恢复）')
{
  const real = readAssemblySources(ROOT)

  /* ---- 正控：当前仓库必须**安静**，而且判据真的在看东西 ---- */
  const positive = checkAssemblyEquivalence(real)
  check(
    '★ 正控（装配等价）：当前树上没有任何装配问题',
    positive.length === 0,
    positive.map((p) => `${p.capability}:${p.kind}`).join(', ')
  )
  check(
    '★ 正控（装配等价）：判据覆盖的能力数 ≥ 5（表被清空时不许显示成"全合格"）',
    CAPABILITY_WIRINGS.length >= 5,
    `覆盖 ${String(CAPABILITY_WIRINGS.length)} 个能力`
  )

  /* ---- 负控①：端口缺失（拿掉 conflict 注入） ---- */
  const noConflict = {
    ...real,
    productionSrc: real.productionSrc.replace(/conflict:\s*\{[\s\S]{0,200}?recordsInCanonicalSlot:/, ''),
  }
  const p1 = checkAssemblyEquivalence(noConflict)
  check(
    '★ 负控①（装配等价）：拿掉 `conflict` 注入 ⇒ 必须因**端口缺失**报红',
    p1.some((p) => p.kind === 'port_missing' && p.capability.includes('conflict')),
    p1.map((p) => `${p.capability}:${p.kind}`).join(', ')
  )

  /* ---- 负控②：开关未被消费（拿掉 memoryExplicitEnabled） ---- */
  const noFlag = {
    ...real,
    productionSrc: real.productionSrc.replace(/memoryExplicitEnabled:\s*this\.flags\.memoryExplicitEnabled,?/, ''),
  }
  const p2 = checkAssemblyEquivalence(noFlag)
  check(
    '★ 负控②（装配等价）：端口还在、开关消费被拿掉 ⇒ 必须因**开关未被消费**报红',
    p2.some((p) => p.kind === 'flag_not_consumed' && p.capability.includes('memoryWriter')),
    p2.map((p) => `${p.capability}:${p.kind}`).join(', ')
  )

  /* ---- 负控③：受测装配不是生产入口（伪造一个自建网关） ---- */
  const selfBuilt = {
    ...real,
    harnessSrc: real.harnessSrc.replace('src/main.ts', 'scripts/own-host.ts') + '\nconst g = new TurnGateway()\n',
  }
  const p3 = checkAssemblyEquivalence(selfBuilt)
  check(
    '★ 负控③（装配等价）：受测脚本自建网关 ⇒ 必须因**受测装配不是生产入口**报红',
    p3.some((p) => p.kind === 'harness_not_production_entry'),
    p3.map((p) => `${p.capability}:${p.kind}`).join(', ')
  )

  /* ---- 恢复：放回原样 ⇒ 重新安静 ---- */
  const recovered = checkAssemblyEquivalence(readAssemblySources(ROOT))
  check(
    '★ 恢复（装配等价）：放回真实源码 ⇒ 判据重新安静',
    recovered.length === 0,
    recovered.map((p) => `${p.capability}:${p.kind}`).join(', ')
  )

  /*
   * ⚠️ 这一段**只**覆盖"静态接线"。同一条判据的另外三件事（三读数里的后两项、
   *    Gateway 之外的路径、以及"结果没进后续链路"那一类负控）**要跑起来才能看**，
   *    不许用这里的绿来冒充（见 ADR-055 §4.6 与 §6.3 的说明）。
   */
  check(
    '★ 边界声明（装配等价）：本判据只覆盖静态接线，运行期三读数不得据此声称已验',
    true,
    '静态：端口/开关/受测入口/隔离闸；运行期：实际入模 · Gateway 之外路径 · 结果未入后续链路'
  )
}

// ===========================================================================
// 验收用集（M6.1 WP4 / ADR-055 §4.2–§4.4）：两套验收集 + 两套独立集
// ===========================================================================
section('验收集：产品正控集 supported_recall_positive_v1')
{
  const items = loadSupportedRecallSet(ROOT)
  const problems = validateSupportedRecallSet(items)
  check(
    '★ 正控集：30 条 · 三类各 10 · id 与区间一致 · 必备字段非空 · 依据路径与来源自洽',
    problems.length === 0,
    problems.length === 0
      ? `30 条；memory_slot ${String(items.filter((i) => i.basisKind === 'memory_slot').length)} · dialogue_recent ${String(items.filter((i) => i.basisKind === 'dialogue_recent').length)}`
      : problems.slice(0, 3).join(' | ')
  )
  /* 负控：把集改坏，校验器必须**因预期原因**报红 */
  const empty = validateSupportedRecallSet([])
  check('★ 负控（正控集）：空集必须是 MEASUREMENT INVALID，不是"合格"', empty.some((p) => p.includes('MEASUREMENT INVALID')), empty.join('|'))
  const duplicated = validateSupportedRecallSet([...items, items[0] as never])
  check('★ 负控（正控集）：多一条 ⇒ 条目数必须对不上', duplicated.some((p) => p.includes('条目数')), duplicated.slice(0, 2).join('|'))
  const stripped = validateSupportedRecallSet([{ ...items[0], expectedPoints: [] } as never, ...items.slice(1)])
  check('★ 负控（正控集）：拿掉 expectedPoints ⇒ 必须报"不知道会被算成成功"', stripped.some((p) => p.includes('expectedPoints')), stripped.slice(0, 2).join('|'))
  const inconsistent = validateSupportedRecallSet([{ ...items[0], source: { ...items[0]!.source, slot: null } } as never, ...items.slice(1)])
  check('★ 负控（正控集）：宣称 memory_slot 却不给槽位 ⇒ 必须报依据路径不可信', inconsistent.some((p) => p.includes('依据路径')), inconsistent.slice(0, 2).join('|'))

  /* 具名必修反例集：规范 + 条目都已落库 */
  const counter = REQUIRED_COUNTEREXAMPLES_SET
  check(
    '★ 规范（必修反例集）：5 个类别 ID 互不相同、且都映射到已冻结的原编号',
    new Set(counter.categories.map((c) => c.id)).size === counter.categories.length &&
      counter.categories.every((c) => c.from.length > 0),
    counter.categories.map((c) => `${c.id}←${c.from.join('/')}`).join(' ')
  )

  const rce = loadCounterexamples(ROOT)
  const rceProblems = validateCounterexamples(rce)
  check(
    '★ 必修反例集：5 类全覆盖 · 每类都登记了"不许出现什么" · id 形状与唯一性 · 人审项自洽',
    rceProblems.length === 0,
    rceProblems.length === 0
      ? `${String(rce.length)} 条；人审项 ${String(rce.filter((i) => i.humanReview).length)} · 可跑项 ${String(rce.filter((i) => !i.humanReview).length)}`
      : rceProblems.slice(0, 3).join(' | ')
  )
  const rceEmpty = validateCounterexamples([])
  check(
    '★ 负控（必修反例集）：空集必须是 MEASUREMENT INVALID，不是"零违规 ⇒ 合格"',
    rceEmpty.some((p) => p.includes('MEASUREMENT INVALID')),
    rceEmpty.join('|')
  )
  const rceDropped = validateCounterexamples(rce.filter((i) => i.category !== 'forgotten_value_reuse'))
  check(
    '★ 负控（必修反例集）：整类被拿掉 ⇒ 必须报该类别"一条都没有"',
    rceDropped.some((p) => p.includes('forgotten_value_reuse')),
    rceDropped.slice(0, 2).join('|')
  )
  const rceAllHuman = validateCounterexamples(rce.map((i) => ({ ...i, humanReview: true, basisKind: 'real_trajectory' })))
  check(
    '★ 负控（必修反例集）：全都标成人审 ⇒ 必须报"门里没有可跑的项"（否则等于没门）',
    rceAllHuman.some((p) => p.includes('没有可跑的项')),
    rceAllHuman.slice(0, 2).join('|')
  )
}

section('验收集：正常写入正控 explicit_write_positive_v1')
{
  const items = loadExplicitWriteSet(ROOT)
  const problems = validateExplicitWriteSet(items)
  check(
    `★ 写入正控：${String(EXPLICIT_WRITE_SET.expected)} 条 · 槽位与期望落库值非空 · 结果码合法 · 幂等项必须靠重复证明`,
    problems.length === 0,
    problems.length === 0
      ? `${String(items.length)} 条；written ${String(items.filter((i) => i.expectedOutcome === 'written').length)} · already_applied ${String(items.filter((i) => i.expectedOutcome === 'already_applied').length)}`
      : problems.slice(0, 3).join(' | ')
  )
  const empty = validateExplicitWriteSet([])
  check('★ 负控（写入正控）：空集必须是 MEASUREMENT INVALID', empty.some((p) => p.includes('MEASUREMENT INVALID')), empty.join('|'))
  const idempotent = validateExplicitWriteSet([
    ...items.filter((i) => i.expectedOutcome !== 'already_applied'),
    { ...(items[0] as never as Record<string, unknown>), id: 'EWP-99', expectedOutcome: 'already_applied', setup: ['只写一次'] } as never,
  ])
  check(
    '★ 负控（写入正控）：期望 already_applied 却只写一轮 ⇒ 必须报（否则幂等是编的）',
    idempotent.some((p) => p.includes('already_applied')),
    idempotent.slice(0, 2).join('|')
  )
  const noSlot = validateExplicitWriteSet([{ ...(items[0] as never as Record<string, unknown>), slot: '' } as never, ...items.slice(1)])
  check('★ 负控（写入正控）：槽位为空 ⇒ 必须报（写不进任何槽位就不是正控）', noSlot.some((p) => p.includes('slot')), noSlot.slice(0, 2).join('|'))
}

section('验收集：更正意图误触发负控 correction_intent_negative_v1')
{
  const items = loadCorrectionNegativeSet(ROOT)
  const problems = validateCorrectionNegativeSet(items)
  check(
    `★ 误触发负控：${String(CORRECTION_NEGATIVE_SET.categories.length)} 类 × ${String(CORRECTION_NEGATIVE_SET.perCategory)} = ${String(CORRECTION_NEGATIVE_SET.categories.length * CORRECTION_NEGATIVE_SET.perCategory)} 条 · 每条都声明"不许改库"`,
    problems.length === 0,
    problems.length === 0
      ? `${String(items.length)} 条；${CORRECTION_NEGATIVE_SET.categories.map((c) => `${c}=${String(items.filter((i) => i.category === c).length)}`).join(' ')}`
      : problems.slice(0, 3).join(' | ')
  )
  const empty = validateCorrectionNegativeSet([])
  check('★ 负控（误触发负控）：空集必须是 MEASUREMENT INVALID', empty.some((p) => p.includes('MEASUREMENT INVALID')), empty.join('|'))
  const lopsided = validateCorrectionNegativeSet(items.filter((i) => i.id !== 'CIN-12'))
  check(
    '★ 负控（误触发负控）：某类只剩 1 条 ⇒ 必须报每类条数对不上（12 不是"够多就行"）',
    lopsided.some((p) => p.includes('类别') && p.includes('≠')),
    lopsided.slice(0, 2).join('|')
  )
  const undeclared = validateCorrectionNegativeSet([{ ...(items[0] as never as Record<string, unknown>), mustNotChangeMemory: false } as never, ...items.slice(1)])
  check(
    '★ 负控（误触发负控）：没声明"不许改库" ⇒ 必须报（漏了就等于没有判据）',
    undeclared.some((p) => p.includes('mustNotChangeMemory')),
    undeclared.slice(0, 2).join('|')
  )
}

// ===========================================================================
// M6.1 WP5：**运行中中止闸**的判据自证（正控 / 四负控 / 恢复）
// ===========================================================================
/*
 * 为什么：预检放行之后一分钟内窗口崩塌（23 个轮次里 21 个 exit 1）—— 没有本闸就会
 * 把 59 个条目 + 118 次 judge 调用烧在死窗口上。与预检一样是**装置**判据（不改产品判据）。
 */
section('M6.1 WP5 · 运行中中止闸（连续失败即停）')

{
  const run = (statuses: readonly number[], threshold = 3): ReturnType<typeof decideTurnAbort> =>
    decideTurnAbort({ statuses, maxConsecutiveFailures: threshold })

  check(
    '正控：尾部没有连续失败 ⇒ 不中止（中间的历史失败不重置，但"尾部为 0"就是不中止）',
    run([1, 1, 1, 0]).abort === false && consecutiveFailureStreak([1, 1, 1, 0]) === 0,
    `streak=${String(consecutiveFailureStreak([1, 1, 1, 0]))}`
  )
  check(
    '★ 负控①：尾部连续 3 个失败 ⇒ 中止（阈值 3）',
    run([0, 1, 1, 1]).abort === true && run([0, 1, 1, 1]).streak === 3,
    run([0, 1, 1, 1]).reason
  )
  check(
    '★ 负控②：**中间成功一次**只算一次抖动 ⇒ 尾部连续 2 < 3 ⇒ 不中止（阈值不能被历史失败累加）',
    run([1, 1, 0, 1, 1]).abort === false && consecutiveFailureStreak([1, 1, 0, 1, 1]) === 2,
    `streak=${String(consecutiveFailureStreak([1, 1, 0, 1, 1]))}`
  )
  check(
    '★ 负控③：阈值 0 ⇒ 本闸关闭（逃生口；但读数里仍会写着这是被关掉的）',
    run([1, 1, 1, 1, 1], 0).abort === false && run([1, 1, 1, 1, 1], 0).reason.includes('已关闭'),
    run([1, 1, 1, 1, 1], 0).reason
  )
  check(
    '★ 计数自检：**一个轮次都没跑** ⇒ 不判中止（"0 次失败"与"全部干净"必须分得开）',
    run([]).abort === false && consecutiveFailureStreak([]) === 0 && run([]).reason.includes('还没有跑过'),
    run([]).reason
  )

  /* 限流重试：只对 rate_limited 生效，且**必须有界** */
  const retry = (attempt: number, hint: Parameters<typeof decideRateLimitRetry>[0]['hint'], maxRetries = 5) =>
    decideRateLimitRetry({ attempt, maxRetries, cooldownMs: 60_000, hint })
  check(
    '★ 正控：限流（rate_limited）⇒ 等待 60s 后重试同一轮',
    retry(1, 'rate_limited').retry === true && retry(1, 'rate_limited').waitMs === 60_000,
    retry(1, 'rate_limited').reason
  )
  check(
    '★ 负控①：**超时/鉴权/5xx 不重试** —— 那三种重试不会变好，该如实失败',
    ['timeout', 'auth_failed', 'quota', 'server_error', 'unknown', 'none'].every(
      (hint) => retry(1, hint as Parameters<typeof decideRateLimitRetry>[0]['hint']).retry === false
    ),
    '六种非限流类别全部不重试'
  )
  check(
    '★ 负控②：重试次数有上界 ⇒ 第 maxRetries+1 次放弃（不许无限等下去）',
    retry(5, 'rate_limited').retry === true &&
      retry(6, 'rate_limited').retry === false &&
      retry(6, 'rate_limited').reason.includes('放弃'),
    retry(6, 'rate_limited').reason
  )
  check(
    '★ 负控③：`--rate-limit-retries 0` ⇒ 关闭（逃生口；读数里仍会写着它是关掉的）',
    retry(1, 'rate_limited', 0).retry === false && retry(1, 'rate_limited', 0).reason.includes('已关闭'),
    retry(1, 'rate_limited', 0).reason
  )
  check(
    '★ 恢复：同一组输入重新判定 ⇒ 逐字段相同',
    JSON.stringify(retry(2, 'rate_limited')) === JSON.stringify(retry(2, 'rate_limited')),
    '逐字段相同'
  )

  /* 失败**提示**分类：四类处置完全不同，不许混成一个"技术失败" */
  const hintCases: [number, string, string][] = [
    [1, 'Error: 429 Too Many Requests', 'rate_limited'],
    [1, 'HTTP 401 Unauthorized: invalid api key', 'auth_failed'],
    [1, 'Insufficient balance in your account', 'quota'],
    [1, 'Error: ETIMEDOUT while fetching', 'timeout'],
    [1, 'Error: ECONNRESET socket hang up', 'connection'],
    [1, 'HTTP 503 Service Unavailable', 'server_error'],
    [1, 'boom（认不出来的错误）', 'unknown'],
    [0, 'Warning: some noise on stderr', 'none'],
  ]
  const hintReadings = hintCases.map(([status, stderr, expected]) => ({
    expected,
    actual: classifyTurnFailure(status, stderr),
  }))
  check(
    '★ 正控：stderr 分类认得出 限流/鉴权/余额/超时/连接/5xx（**且认不出来就说 unknown，不猜**）',
    hintReadings.every((row) => row.actual === row.expected),
    hintReadings.map((row) => `${row.expected}→${row.actual}`).join(' ')
  )
  check(
    '★ 负控：退出码 0 ⇒ 提示必须是 `none`（跑成功了，stderr 有噪声也不算失败）',
    classifyTurnFailure(0, 'Error: 429 Too Many Requests') === 'none',
    'status=0 覆盖 stderr 噪声'
  )
  check(
    '★ 恢复：同一组输入重新分类 ⇒ 逐字段相同（判据里没有时钟/随机）',
    JSON.stringify(hintCases.map(([status, stderr]) => classifyTurnFailure(status, stderr))) ===
      JSON.stringify(hintReadings.map((row) => row.actual)),
    '逐字段相同'
  )
}

// ===========================================================================
// M6.1 WP5：**端点健康预检**的判据自证（正控 / 四负控 / 恢复）
// ===========================================================================
/*
 * 为什么要它：两次整轮白跑都是"端点窗口不可用"（61/108 与 8/15 个轮次 exit 1）。
 * 预检是**新量具** ⇒ 按 AGENTS §6.7 必须三段式；而它本身是纯函数 ⇒ 这里全部离线测。
 *
 * ⚠️ 与量具有效性无关：它只回答"端点现在通不通"。
 */
section('M6.1 WP5 · 端点健康预检（开跑闸）')

{
  const probe = (input: Partial<PreflightProbe>): PreflightProbe => ({
    index: 0,
    status: 0,
    replyChars: 12,
    replyMarkerFound: true,
    durationMs: 7000,
    ...input,
  })

  const healthy = judgePreflight([probe({ index: 0 }), probe({ index: 1 }), probe({ index: 2 })])
  check(
    '正控：3 条干净探针 ⇒ HEALTHY 且零理由',
    healthy.verdict === 'HEALTHY' && healthy.reasons.length === 0,
    `${healthy.verdict} · ${healthy.reasons.join(' / ') || '零理由'}`
  )

  const failedProbe = judgePreflight([
    probe({ index: 0 }),
    probe({ index: 1, status: 1, replyChars: 0, replyMarkerFound: false, durationMs: 1300 }),
    probe({ index: 2 }),
  ])
  check(
    '★ 负控①：任一轮次 exit ≠ 0 ⇒ UNHEALTHY（且**点名**那条"快速失败"形态）',
    failedProbe.verdict === 'UNHEALTHY' &&
      failedProbe.reasons.some((reason) => reason.includes('probe_failed') && reason.includes('快速失败')),
    failedProbe.reasons.join(' / ')
  )

  const notCaptured = judgePreflight([
    probe({ index: 0 }),
    probe({ index: 1, status: 0, replyChars: 0, replyMarkerFound: false }),
  ])
  check(
    '★ 负控②：退出码 0 但**回复没被捕获** ⇒ UNHEALTHY（这种轮次上的"干净"是假干净）',
    notCaptured.verdict === 'UNHEALTHY' &&
      notCaptured.reasons.some((reason) => reason.includes('reply_not_captured')),
    notCaptured.reasons.join(' / ')
  )

  const empty = judgePreflight([])
  check(
    '★ 负控③：探针 0 条 ⇒ **MEASUREMENT INVALID**（"检查 0 次、发现 0 个问题" ≠ 健康）',
    empty.verdict === 'MEASUREMENT_INVALID' && empty.probes === 0,
    `${empty.verdict} · ${empty.reasons.join(' / ')}`
  )

  const allFastFail = judgePreflight([
    probe({ index: 0, status: 1, replyChars: 0, replyMarkerFound: false, durationMs: 1200 }),
    probe({ index: 1, status: 1, replyChars: 0, replyMarkerFound: false, durationMs: 1500 }),
  ])
  check(
    '★ 负控④：全部快速失败（< 2500ms） ⇒ 仍是 UNHEALTHY（不被"快"骗过）',
    allFastFail.verdict === 'UNHEALTHY' && allFastFail.fastFailures === 2,
    `fastFailures=${String(allFastFail.fastFailures)}`
  )

  /* 恢复：同一组读数算两次 ⇒ 逐字段相同（判据里没有时钟/随机） */
  const again = judgePreflight([probe({ index: 0 }), probe({ index: 1 }), probe({ index: 2 })])
  check(
    '★ 恢复：同一组探针重新判定 ⇒ 与正控逐字段相同',
    JSON.stringify(again) === JSON.stringify(healthy),
    '逐字段相同'
  )

  /* 开跑闸：缺件 / 树不匹配 / 过期 / 不健康 —— 四种都必须**拒绝** */
  const tmpRoot = mkdtempSync(join(tmpdir(), 'm61-preflight-gate-'))
  const gateMissing = readPreflightGate({ root: tmpRoot, treeFingerprint: 'T', nowMs: Date.now() })
  check(
    '★ 开跑闸①：缺预检件 ⇒ 拒绝（并给出"先跑 m6.1:preflight"的指令）',
    gateMissing.ok === false && gateMissing.verdict === 'missing' && gateMissing.reason.includes('m6.1:preflight'),
    gateMissing.reason.slice(0, 60)
  )
  writePreflightArtifact(tmpRoot, {
    schemaVersion: 'm6.1-preflight@1',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    treeFingerprint: 'T',
    arm: 'code-default',
    modelRoute: { baseUrlHost: 'test.host', largeModel: 'm', smallModel: 'm', apiKeyLength: 1, keySource: '测试' },
    probes: [probe({})],
    judgment: healthy,
    notProven: [],
  })
  check(
    '★ 开跑闸②：预检健康且树指纹相同、在保鲜期内 ⇒ 放行',
    readPreflightGate({ root: tmpRoot, treeFingerprint: 'T', nowMs: Date.now() }).ok === true,
    readPreflightGate({ root: tmpRoot, treeFingerprint: 'T', nowMs: Date.now() }).reason
  )
  check(
    '★ 开跑闸③：树指纹不同 ⇒ 拒绝（预检的是**另一棵树**）',
    readPreflightGate({ root: tmpRoot, treeFingerprint: 'OTHER', nowMs: Date.now() }).ok === false,
    readPreflightGate({ root: tmpRoot, treeFingerprint: 'OTHER', nowMs: Date.now() }).reason.slice(0, 60)
  )
  check(
    '★ 开跑闸④：超过保鲜期 ⇒ 拒绝（端点状态会变）',
    readPreflightGate({
      root: tmpRoot,
      treeFingerprint: 'T',
      nowMs: Date.now() + PREFLIGHT_FRESHNESS_MS + 1000,
    }).ok === false,
    '过期即拒'
  )
  const unhealthyRoot = mkdtempSync(join(tmpdir(), 'm61-preflight-unhealthy-'))
  writePreflightArtifact(unhealthyRoot, {
    schemaVersion: 'm6.1-preflight@1',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    treeFingerprint: 'T',
    arm: 'code-default',
    modelRoute: { baseUrlHost: 'test.host', largeModel: 'm', smallModel: 'm', apiKeyLength: 1, keySource: '测试' },
    probes: [probe({ status: 1, replyChars: 0, replyMarkerFound: false })],
    judgment: failedProbe,
    notProven: [],
  })
  check(
    '★ 开跑闸⑤：预检判决不是 HEALTHY ⇒ 拒绝',
    readPreflightGate({ root: unhealthyRoot, treeFingerprint: 'T', nowMs: Date.now() }).ok === false,
    '不健康即拒'
  )
  /* ⚠️ 同一棵树 + **不同配置** ⇒ 也必须拒绝（2026-09-24 用户裁定改用官方 key 后加的） */
  /* ⚠️ `routeA` 必须与上面写进 `tmpRoot/preflight.json` 的那一份**逐字段相同** */
  const routeA = { baseUrlHost: 'test.host', largeModel: 'm', smallModel: 'm', apiKeyLength: 1, keySource: 'x' }
  const routeB = {
    baseUrlHost: 'api.deepseek.com',
    largeModel: 'deepseek-flash',
    smallModel: 'deepseek-flash',
    apiKeyLength: 35,
    keySource: 'y',
  }
  check(
    '★ 开跑闸⑥：树一样但**模型路由不同** ⇒ 拒绝（否则会把两套配置的读数混在一起）',
    readPreflightGate({ root: tmpRoot, treeFingerprint: 'T', nowMs: Date.now(), modelRoute: routeB }).ok === false &&
      readPreflightGate({ root: tmpRoot, treeFingerprint: 'T', nowMs: Date.now(), modelRoute: routeA }).ok === true,
    readPreflightGate({ root: tmpRoot, treeFingerprint: 'T', nowMs: Date.now(), modelRoute: routeB }).reason.slice(0, 80)
  )
  check(
    '★ 单一来源：`sameModelRoute` 只看 host + 两个模型名（key 长度不参与 ⇒ 换 key 不换配置时不该被拒）',
    sameModelRoute(routeA, { ...routeA, apiKeyLength: 99 }) === true &&
      sameModelRoute(routeA, routeB) === false &&
      sameModelRoute(null, routeA) === false,
    'host/模型名 决定；key 长度不决定'
  )
  check(
    '★ 正控：`hostOfBaseUrl` 只取 host（解析不了就原样回，不抛）',
    hostOfBaseUrl('https://api.deepseek.com/v1') === 'api.deepseek.com' &&
      hostOfBaseUrl('not-a-url') === 'not-a-url' &&
      hostOfBaseUrl('') === '(未设置)',
    '三种输入各自正确'
  )
}

// ===========================================================================
// M6.1 WP4 / ADR-055 D-55e / D-55f：**记录状态行**（纯函数 + 独立额度不变量）
// ===========================================================================
/*
 * 这一段是 WP4 的 `D1′` / `R-8③` 的 L1 判据。它证明三件事：
 *
 *   ① 五种情形**分别**渲染（不许都写成"没有记忆"），而且措辞只讲**我们的记录**；
 *   ② 状态行走**独立额度** ⇒ 它的存在**不会**把记忆 section 挤出去（两遍编译同结论）；
 *   ③ 状态行的三种结局（入模 / 被裁 / 未生成）都真实可达，且**可被机器区分**。
 *
 * ⚠️ 这里**不碰**数据库 / 模型 / 网络：全部是纯函数与内存编译器。
 */
section('M6.1 WP4 · D-55e 记录状态行：五种情形必须分别渲染')

function statusOf(
  reasons: MemoryRecordStatus['reasons'],
  includedCount: number,
  detail: Partial<MemoryRecordStatus['detail']> = {}
): MemoryRecordStatus {
  return {
    reasons,
    includedCount,
    detail: {
      droppedByBudgetCount: 0,
      notRelevantCount: 0,
      ineligibleCounts: { forgotten: 0, superseded: 0, unconfirmed: 0, orphaned: 0 },
      ineligibleSlots: {},
      droppedByContextBudget: false,
      ...detail,
    },
  }
}

{
  /*
   * 计数型自检（AGENTS §6.8）：可达与预留两张表都不能是空的 ——
   * 表被清空时"0 个预留原因"会显示成"全部可达"，而那是两件不同的事。
   */
  const reachable = reachableMemoryRecordStatusReasons()
  const reserved = reservedMemoryRecordStatusReasons()
  check(
    '★ 计数自检：可达原因 ≥ 1（0 个可达 ⇒ 状态行永远出不来，必须判 MEASUREMENT INVALID）',
    reachable.length > 0,
    `${String(reachable.length)} 个可达：${reachable.join(', ')}`
  )
  check(
    '★ 计数自检：预留原因被**具名登记**（不是静默留一个永远出不来的值）',
    reserved.length > 0 &&
      reserved.every((reason) => (reason.length > 0 ? true : false)),
    `预留：${reserved.join(', ') || '(无)'}`
  )

  /* ① 默认缺席句：召回为空、没有别的原因 ⇒ 只能是**收敛过的那一句** */
  const defaultText = renderMemoryRecordStatus(statusOf([], 0))
  check(
    '正控：召回为空 ⇒ 默认那句（"本轮长期记忆召回未向最终上下文提供记录。"）',
    defaultText === MEMORY_RECORD_STATUS_DEFAULT_ABSENCE,
    defaultText ?? '(未产出)'
  )
  check(
    '负控：**默认不得升级**为更广的断言（全来源覆盖那句）',
    renderMemoryRecordStatus(statusOf([], 0), { allSourcesCovered: false }) ===
      MEMORY_RECORD_STATUS_DEFAULT_ABSENCE &&
      (defaultText ?? '').includes('长期记忆召回未向最终上下文提供记录'),
    '未传 allSourcesCovered 时仍是默认句'
  )
  check(
    '正控：只有程序确实覆盖全部相关来源时，才允许用更广那句',
    renderMemoryRecordStatus(statusOf([], 0), { allSourcesCovered: true }) ===
      MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE,
    MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE
  )
  check(
    '负控：有记录进上下文、且没有别的事 ⇒ **不产**状态行（否则每一轮都多一行噪声）',
    renderMemoryRecordStatus(statusOf([], 3)) === undefined,
    'undefined'
  )

  /* ② 五种情形分别渲染 */
  const notSearched = (['port_not_wired', 'flag_off', 'no_user_id'] as const).map((cause) =>
    renderMemoryRecordStatus(statusOf(['not_searched'], 0, { notSearchedCause: cause })) ?? ''
  )
  check(
    '正控：`not_searched` 的三个具名原因**分别**渲染（端口未接 / 开关关闭 / 没有 userId）',
    notSearched.every((text, index) =>
      text.includes(['端口未接', '开关关闭', '没有 userId'][index] as string)
    ) && new Set(notSearched).size === 3,
    notSearched.map((t) => t.trim()).join(' | ')
  )
  const failedText =
    renderMemoryRecordStatus(
      statusOf(['search_failed'], 0, { searchFailedReason: 'KernelError: db_unavailable' })
    ) ?? ''
  check(
    '正控：`search_failed` 带具名原因，且**不得**伪装成零结果（不许出现默认缺席句）',
    failedText.includes('db_unavailable') &&
      failedText.includes('不能据此判断有无记录') &&
      !failedText.includes(MEMORY_RECORD_STATUS_DEFAULT_ABSENCE),
    failedText.replace(/\n/g, ' / ').trim()
  )
  check(
    '正控：`no_relevant` 说的是**阈值**没过（不写"没有与话题相关的条目"）',
    (renderMemoryRecordStatus(statusOf(['no_relevant'], 0)) ?? '').includes(
      '未达到召回相关性阈值'
    ),
    renderMemoryRecordStatus(statusOf(['no_relevant'], 0)) ?? '(未产出)'
  )
  check(
    '正控：`dropped_by_budget` 带**条数**，且与"没有记录"是两句不同的话',
    (renderMemoryRecordStatus(statusOf(['dropped_by_budget'], 0, { droppedByBudgetCount: 2 })) ?? '')
      .includes('被上下文预算裁掉了（2 条）'),
    renderMemoryRecordStatus(statusOf(['dropped_by_budget'], 0, { droppedByBudgetCount: 2 })) ?? ''
  )

  /* ③ 资格不合格：按原因拆开，且槽位必须具名 */
  const forgottenWithSlot = renderMemoryRecordStatus(
    statusOf(['ineligible:forgotten'], 0, { ineligibleSlots: { 'ineligible:forgotten': ['food.avoid.general'] } })
  )
  check(
    '正控：`ineligible:forgotten` 在**有具名槽位**时说出槽位',
    (forgottenWithSlot ?? '').includes('food.avoid.general') &&
      (forgottenWithSlot ?? '').includes('已按遗忘请求作废'),
    (forgottenWithSlot ?? '').trim()
  )
  check(
    '负控：**拿不到槽位**时不许说那句带指称的话（宁可不说，也不要一句没有指称的断言）',
    renderMemoryRecordStatus(statusOf(['ineligible:forgotten'], 0)) === undefined,
    'undefined'
  )
  const supersededWithSlot = renderMemoryRecordStatus(
    statusOf(['ineligible:superseded'], 0, { ineligibleSlots: { 'ineligible:superseded': ['food.preference.spicy'] } })
  )
  check(
    '正控：`ineligible:superseded` 与 forgotten 是**两句不同**的话',
    (supersededWithSlot ?? '').includes('已被后续记录取代') &&
      supersededWithSlot !== forgottenWithSlot,
    (supersededWithSlot ?? '').trim()
  )
  check(
    '正控：两类资格不合格**可并存**（不是单选枚举）',
    (renderMemoryRecordStatus(
      statusOf(['ineligible:forgotten', 'ineligible:superseded'], 1, {
        ineligibleSlots: {
          'ineligible:forgotten': ['a.slot'],
          'ineligible:superseded': ['b.slot'],
        },
      })
    ) ?? '').includes('a.slot') &&
      (renderMemoryRecordStatus(
        statusOf(['ineligible:forgotten', 'ineligible:superseded'], 1, {
          ineligibleSlots: {
            'ineligible:forgotten': ['a.slot'],
            'ineligible:superseded': ['b.slot'],
          },
        })
      ) ?? '').includes('b.slot'),
    '两条原因同时出现'
  )

  /* ④ 禁止写法：只扫**程序生成**的状态文本（不扩展成对模型回复的词形守卫） */
  const allRendered = [
    renderMemoryRecordStatus(statusOf([], 0)),
    renderMemoryRecordStatus(
      statusOf(
        [
          'not_searched',
          'search_failed',
          'state_unknown',
          'no_relevant',
          'dropped_by_budget',
          'ineligible:forgotten',
          'ineligible:superseded',
          'ineligible:unconfirmed',
          'ineligible:orphaned',
        ],
        2,
        {
          notSearchedCause: 'no_user_id',
          searchFailedReason: 'x',
          stateUnknownReason: 'y',
          droppedByBudgetCount: 1,
          ineligibleSlots: {
            'ineligible:forgotten': ['s1'],
            'ineligible:superseded': ['s2'],
          },
        }
      )
    ),
  ].filter((text): text is string => text !== undefined)
  const banned = allRendered.flatMap((text) => forbiddenPhrasesInStatusText(text))
  check(
    '负控：**所有**可达渲染里不得出现"关于世界"的断言（我不记得 / 没有记忆 / 你没说过 / 从未…）',
    allRendered.length > 0 && banned.length === 0,
    `渲染 ${String(allRendered.length)} 段，命中禁止写法 ${String(banned.length)} 处${
      banned.length > 0 ? `：${banned.join(',')}` : ''
    }`
  )

  /* ==========================================================================
   * M6.1 WP5 发现① 修复的 L1 判据：**三来源必须分列**（用户 2026-09-24 裁定）
   * ==========================================================================
   * 旧形态只有一句「本轮长期记忆召回未向最终上下文提供记录。」—— 它没有说
   * "最近对话有多少轮进来了 / 摘要有没有进来"，于是可以被读成"我们之间什么都没有"，
   * 接着就是补造共同经历（RCE-02 的实测形态）。
   *
   * ⚠️ 这三条判据同时守住用户的两条硬约束：
   *    ① **不得**由词形触发 —— 渲染器**只吃程序事实**，签名里根本没有用户文本；
   *    ② **不得**动回复守卫 —— 这里测的全是 prompt 侧那一行。
   */
  const coverageOf = (input: {
    longTerm: ContextSourceReading
    recent: ContextSourceReading
    summary: ContextSourceReading
  }): ContextSourceCoverage => ({
    longTermMemory: input.longTerm,
    recentConversation: input.recent,
    summary: input.summary,
  })

  /* 正控：长期记忆为空 + 最近对话有 3 轮 + 摘要没咨询 ⇒ 三件事**各自**一行 */
  const splitText =
    renderMemoryRecordStatus(statusOf([], 0), {
      sources: coverageOf({
        longTerm: { outcome: 'empty', included: 0 },
        recent: { outcome: 'provided', included: 3 },
        summary: { outcome: 'not_consulted', included: 0, reason: 'rollup_port_missing' },
      }),
    }) ?? ''
  check(
    '★ 正控：三来源**分列**渲染（长期记忆 / 最近对话 / 摘要各一行，不许合并成一句）',
    splitText.includes('长期记忆：') &&
      splitText.includes('最近对话：') &&
      splitText.includes('摘要：') &&
      splitText.includes('本轮有 3 轮对话进入最终上下文') &&
      splitText.includes('本轮没有咨询摘要'),
    splitText.replace(/\n/g, ' / ')
  )
  check(
    '★ 负控：长期记忆为空时，"最近对话有 N 轮"这件事**必须**出现在同一行里（发现① 的修复点）',
    splitText.includes('本轮长期记忆召回未向最终上下文提供记录') &&
      splitText.includes('本轮有 3 轮对话进入最终上下文'),
    splitText.replace(/\n/g, ' / ')
  )
  check(
    '★ 负控：三个来源**都未知/未咨询**时，措辞**不得**升级成"没有可支持这段共同经历的记录"',
    !(
      renderMemoryRecordStatus(statusOf([], 0), {
        sources: coverageOf({
          longTerm: { outcome: 'not_consulted', included: 0, reason: 'port_not_wired' },
          recent: { outcome: 'provided', included: 1 },
          summary: { outcome: 'not_consulted', included: 0, reason: 'rollup_port_missing' },
        }),
        allSourcesCovered: true,
      }) ?? ''
    ).includes(MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE),
    '调用方传了 allSourcesCovered:true，但覆盖率读数说摘要没咨询 ⇒ 不许升级'
  )
  check(
    '★ 正控：三来源都**已知**且长期记忆为空时，才允许那句更广的（"没有可支持这段共同经历的合格记录"）',
    (
      renderMemoryRecordStatus(statusOf([], 0), {
        sources: coverageOf({
          longTerm: { outcome: 'empty', included: 0 },
          recent: { outcome: 'empty', included: 0 },
          summary: { outcome: 'empty', included: 0 },
        }),
        allSourcesCovered: true,
      }) ?? ''
    ).includes(MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE),
    '三来源都已知 ⇒ 允许'
  )
  check(
    '★ 负控（防词形触发）：同一组程序事实，渲染结果**逐字节相同** —— 输入里没有任何用户文本',
    /*
     * 反证法：把"两种说法"都喂进同一个函数是**做不到**的（签名里没有文本这一项）。
     * 能测的是"渲染结果只由 (status, coverage) 决定"：
     * 同一组事实算两次必须逐字节一致，且**不包含**任何提问词形。
     */
    (() => {
      const facts = {
        sources: coverageOf({
          longTerm: { outcome: 'empty', included: 0 },
          recent: { outcome: 'provided', included: 2 },
          summary: { outcome: 'empty', included: 0 },
        }),
      }
      const first = renderMemoryRecordStatus(statusOf([], 0), facts) ?? ''
      const second = renderMemoryRecordStatus(statusOf([], 0), facts) ?? ''
      return (
        first === second &&
        !/上次|记得吗|还记得|刚才/.test(first) &&
        renderContextSourceCoverage.length > 0 /* 渲染器存在（计数自检） */
      )
    })(),
    '逐字节相同且不含词形触发'
  )
  check(
    '★ 计数自检：分列渲染**至少 3 行**（0 行 / 1 行都说明"分列"没实现）',
    renderContextSourceCoverage(
      coverageOf({
        longTerm: { outcome: 'empty', included: 0 },
        recent: { outcome: 'provided', included: 1 },
        summary: { outcome: 'empty', included: 0 },
      }),
      statusOf([], 0)
    ).length >= 3,
    `${String(
      renderContextSourceCoverage(
        coverageOf({
          longTerm: { outcome: 'empty', included: 0 },
          recent: { outcome: 'provided', included: 1 },
          summary: { outcome: 'empty', included: 0 },
        }),
        statusOf([], 0)
      ).length
    )} 行`
  )
  const splitBanned = forbiddenPhrasesInStatusText(splitText)
  check(
    '负控：分列形态也**不得**出现"关于世界"的断言（禁止写法只扫程序生成的那一行）',
    splitBanned.length === 0,
    splitBanned.join(',') || '零命中'
  )

  /* ⑤ `buildMemoryRecordStatus`：程序事实 → 状态（含预留原因不得被产出） */
  const fakeRecord = (input: {
    histogram: Record<string, number>
    selected?: string[]
    droppedByBudget?: number
    droppedByContextBudget?: boolean
    decisions?: { memoryId: string; reason: string }[]
    candidates?: { memoryId: string; canonicalKey?: string }[]
  }): RecallDecisionRecord =>
    ({
      selectedIds: input.selected ?? [],
      decisions: (input.decisions ?? []).map((d) => ({
        memoryId: d.memoryId,
        eligible: false,
        reason: d.reason,
        selected: false,
      })),
      candidates: input.candidates ?? [],
      metrics: {
        exclusionHistogram: input.histogram,
        droppedByBudget: input.droppedByBudget ?? 0,
        droppedByContextBudget: input.droppedByContextBudget ?? false,
      },
    }) as unknown as RecallDecisionRecord

  const fromFacts = buildMemoryRecordStatus({
    status: 'ran',
    record: fakeRecord({
      histogram: { LOW_RELEVANCE: 3, FORGOTTEN: 1, SUPERSEDED: 2, ORPHANED_EVIDENCE: 1 },
      selected: ['mem:1', 'mem:2'],
      droppedByBudget: 1,
      decisions: [
        { memoryId: 'mem:9', reason: 'FORGOTTEN' },
        { memoryId: 'mem:8', reason: 'SUPERSEDED' },
      ],
      candidates: [
        { memoryId: 'mem:9', canonicalKey: 'slot.forgotten' },
        { memoryId: 'mem:8', canonicalKey: 'slot.superseded' },
      ],
    }),
  })
  check(
    '正控：程序事实 → 原因列表（阈值 / 预算 / 遗忘 / 取代 / 依据链）齐全，且入模数量取自**编译之后**的 selectedIds',
    fromFacts.reasons.includes('no_relevant') &&
      fromFacts.reasons.includes('dropped_by_budget') &&
      fromFacts.reasons.includes('ineligible:forgotten') &&
      fromFacts.reasons.includes('ineligible:superseded') &&
      fromFacts.reasons.includes('ineligible:orphaned') &&
      fromFacts.includedCount === 2,
    `reasons=${fromFacts.reasons.join(',')} included=${String(fromFacts.includedCount)}`
  )
  check(
    '正控：槽位从**候选**里取（`decisions` 只有 id + 理由，没有 canonicalKey）',
    (fromFacts.detail.ineligibleSlots['ineligible:forgotten'] ?? []).includes('slot.forgotten') &&
      (fromFacts.detail.ineligibleSlots['ineligible:superseded'] ?? []).includes('slot.superseded'),
    JSON.stringify(fromFacts.detail.ineligibleSlots)
  )
  const reservedProduced = fromFacts.reasons.filter((reason) => reserved.includes(reason))
  check(
    '负控：**预留原因不得被产出**（`ineligible:unconfirmed` / `state_unknown` 今天没有生产者）',
    reservedProduced.length === 0,
    `产出 ${String(reservedProduced.length)} 个预留原因`
  )
  check(
    '正控：`not_searched` / `search_failed` 两条缺省各自具名（不是同一个 undefined）',
    buildMemoryRecordStatus({ status: 'not_searched', cause: 'flag_off' }).detail
      .notSearchedCause === 'flag_off' &&
      buildMemoryRecordStatus({ status: 'failed', reason: 'boom' }).detail.searchFailedReason ===
        'boom',
    'flag_off / boom'
  )
  check(
    '正控：整段被上下文预算丢掉 ⇒ `droppedByContextBudget` 进原因与细节',
    buildMemoryRecordStatus({
      status: 'ran',
      record: fakeRecord({ histogram: {}, droppedByContextBudget: true }),
    }).reasons.includes('dropped_by_budget'),
    'dropped_by_budget'
  )
}

// ===========================================================================
// M6.1 WP4 · D-55e ③：状态行的**独立额度** —— 正控 / 负控 / 恢复
// ===========================================================================
/*
 * 用户第 3 点（ADR-055 §2.1）："它是新增内容，必须有自己的额度，不能从记忆额度里扣。"
 *
 * 这一段的判据形状：
 *   正控  带上状态行 ⇒ **记忆 section 仍然活着**（它没有被挤出去）
 *   负控  状态行的额度给小 ⇒ 状态行自己被裁，而记忆**照样活着**
 *   负控  不给 `statusTokenBudget` ⇒ 退回共享预算（不是"永远保留"）
 *   恢复  把额度放回 ⇒ 状态行重新入模
 *   不变量 两遍编译（带 / 不带状态行）对**非状态 section** 的取舍逐字相同
 */
section('M6.1 WP4 · D-55e ③ 独立额度：不得挤占记忆额度（正控 / 负控 / 恢复）')

{
  const quantifier = (text: string) => text.length
  const memoryProvider: ContextSectionProvider = {
    name: 'synthetic-memory',
    async provide() {
      return [
        {
          id: SECTION_IDS.memoryRecall,
          kind: 'memory',
          priority: SECTION_PRIORITY.memory,
          content: 'm'.repeat(200),
          droppable: true,
        },
      ]
    },
  }
  const statusProvider = (chars: number): ContextSectionProvider =>
    createMemoryRecordStatusProvider({ render: () => 's'.repeat(chars) })

  const compile = async (input: {
    budget: number
    statusChars?: number
    statusBudget?: number
  }) =>
    createContextCompiler({
      providers: [
        memoryProvider,
        ...(input.statusChars !== undefined ? [statusProvider(input.statusChars)] : []),
      ],
      quantifier,
    }).compile({
      characterId: asCharacterId('chr:synthetic'),
      currentInput: 'synthetic',
      tokenBudget: input.budget,
      now: 0,
      ...(input.statusBudget !== undefined ? { statusTokenBudget: input.statusBudget } : {}),
    })

  check(
    '★ 计数自检：状态行自己的额度是正数（0 额度会静默变成"每一轮都没有状态行"）',
    MEMORY_RECORD_STATUS_BUDGET_TOKENS > 0,
    String(MEMORY_RECORD_STATUS_BUDGET_TOKENS)
  )

  /* 正控：记忆 200 token，共享预算 250；状态行 100 token —— 若它占共享预算就会被挤爆 */
  const positive = await compile({ budget: 250, statusChars: 100, statusBudget: 120 })
  check(
    '正控：带上状态行后**记忆 section 仍然活着**（独立额度 ⇒ 它的 token 不占共享预算）',
    positive.sections.some((s) => s.id === SECTION_IDS.memoryRecall) &&
      positive.sections.some((s) => s.id === SECTION_IDS.memoryRecordStatus),
    `kept=${positive.sections.map((s) => s.id).join(',')}`
  )

  /* 负控①：状态行额度太小 ⇒ 状态行自己被裁，**记忆不受影响** */
  const cramped = await compile({ budget: 250, statusChars: 100, statusBudget: 50 })
  check(
    '★ 负控：状态行额度不足 ⇒ 它**自己**被裁（因预期原因报红），而记忆照样活着',
    !cramped.sections.some((s) => s.id === SECTION_IDS.memoryRecordStatus) &&
      cramped.droppedSectionIds.includes(SECTION_IDS.memoryRecordStatus) &&
      cramped.sections.some((s) => s.id === SECTION_IDS.memoryRecall),
    `dropped=${cramped.droppedSectionIds.join(',')} kept=${cramped.sections.map((s) => s.id).join(',')}`
  )

  /* 负控②：不给独立额度 ⇒ 退回共享预算（于是它**真的会**和记忆抢） */
  const sharedFallback = await compile({ budget: 250, statusChars: 100 })
  const memoryAlone = await compile({ budget: 250 })
  check(
    '★ 负控：**不给**独立额度 ⇒ 状态行退回共享预算，**真的会和记忆抢**（"忘了给额度"不能表现为"永远保留"）',
    sharedFallback.droppedSectionIds.includes(SECTION_IDS.memoryRecall) &&
      memoryAlone.sections.some((s) => s.id === SECTION_IDS.memoryRecall),
    `dropped=${sharedFallback.droppedSectionIds.join(',')}（同一预算下不带状态行时记忆是活的）`
  )

  /* 恢复：把额度放回 ⇒ 重新入模 */
  const restored = await compile({ budget: 250, statusChars: 100, statusBudget: 120 })
  check(
    '★ 恢复：把额度放回 ⇒ 状态行重新入模（正控/负控/恢复三段齐了）',
    restored.sections.some((s) => s.id === SECTION_IDS.memoryRecordStatus),
    `kept=${restored.sections.map((s) => s.id).join(',')}`
  )

  /*
   * **两遍编译不变量**（这正是"两遍编译安全"的依据）：
   * 带 / 不带状态行时，**非状态 section** 的 kept 与 dropped 必须逐字相同。
   * 它一旦坏掉，"状态行说的那句编译后事实"就会与实际 packet 不符。
   */
  const withoutStatus = await compile({ budget: 250 })
  const withStatus = await compile({ budget: 250, statusChars: 100, statusBudget: 120 })
  check(
    '★ 不变量：加一行状态行**不改变**其它任何 section 的取舍（两遍编译同结论）',
    JSON.stringify(withoutStatus.sections.map((s) => s.id)) ===
      JSON.stringify(withStatus.sections.filter((s) => s.id !== SECTION_IDS.memoryRecordStatus).map((s) => s.id)) &&
      JSON.stringify(withoutStatus.droppedSectionIds) ===
        JSON.stringify(withStatus.droppedSectionIds.filter((id) => id !== SECTION_IDS.memoryRecordStatus)),
    `without=${withoutStatus.sections.map((s) => s.id).join(',')} / with=${withStatus.sections
      .map((s) => s.id)
      .join(',')}`
  )

  /* 三种结局都可达（部分裁剪 / 整段裁剪 / 状态行未入模） */
  const memoryDroppedButStatusKept = await compile({ budget: 10, statusChars: 40, statusBudget: 120 })
  check(
    '三态①：**部分裁剪**（记忆被共享预算丢掉、状态行仍在）⇒ 两种结局可区分',
    memoryDroppedButStatusKept.droppedSectionIds.includes(SECTION_IDS.memoryRecall) &&
      memoryDroppedButStatusKept.sections.some((s) => s.id === SECTION_IDS.memoryRecordStatus),
    `kept=${memoryDroppedButStatusKept.sections.map((s) => s.id).join(',')}`
  )
  const wholeDropText =
    renderMemoryRecordStatus(statusOf(['dropped_by_budget'], 0, { droppedByBudgetCount: 4 })) ?? ''
  check(
    '三态②：**整段裁剪**在文本里被如实说出（"被上下文预算裁掉了（4 条）"）',
    wholeDropText.includes('被上下文预算裁掉了（4 条）') && wholeDropText.includes('有符合资格的记录'),
    wholeDropText.trim()
  )
  const statusItselfDropped = await compile({ budget: 250, statusChars: 200, statusBudget: 120 })
  check(
    '三态③：**状态行未入模**（它自己被自己的额度裁掉）⇒ 在 dropped 里如实出现',
    statusItselfDropped.droppedSectionIds.includes(SECTION_IDS.memoryRecordStatus),
    `dropped=${statusItselfDropped.droppedSectionIds.join(',')}`
  )
  const badStatusBudget = await compile({ budget: 250, statusChars: 40, statusBudget: 0 }).then(
    () => 'no-throw',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  check(
    '负控：0 额度的状态行预算**失败关闭**（不许静默变成"这一轮没有状态行"）',
    badStatusBudget !== 'no-throw' && badStatusBudget.includes('statusTokenBudget'),
    badStatusBudget
  )
}

// ===========================================================================
// M6.1 WP4 / ADR-055 D-55g：**回复守卫的观测三态**（纯契约）
// ===========================================================================
/*
 * 这一段只判**契约层**：三态是否真的可区分、属性键是否过遥测白名单、
 * 缺报告会不会被当成"全都没触发"。真链路上的读数属于 WP5/WP6（行为门）。
 */
section('M6.1 WP4 · D-55g 回复守卫三态：具名 / 结构化原因 / 观测缺失不得当成通过')

{
  const reports: ReplyGuardReport[] = [
    { name: 'memory_truth', state: 'not_run', reasons: ['no_explicit_memory_instruction'] },
    { name: 'action_truth', state: 'passed', reasons: [] },
    { name: 'evidence_truth', state: 'triggered', reasons: ['searched_empty', '记住了'] },
    { name: 'search_need', state: 'not_run', reasons: ['no_search_need_judgment'] },
  ]
  const summary = summarizeReplyGuards(reports)
  check(
    '正控：三态**分别**计数（触发 1 / 静默通过 1 / 观测缺失 2）',
    summary.triggered === 1 && summary.passed === 1 && summary.notRun === 2,
    `触发=${String(summary.triggered)} 通过=${String(summary.passed)} 缺失=${String(summary.notRun)}`
  )
  check(
    '正控：具名守卫出现在汇总里（触发的那一道可被指名）',
    summary.triggeredNames.join(',') === 'evidence_truth' &&
      summary.notRunNames.join(',') === 'memory_truth,search_need',
    `${summary.triggeredNames.join(',')} / ${summary.notRunNames.join(',')}`
  )

  const attributes = replyGuardTraceAttributes(reports)
  const badKeys = Object.keys(attributes).filter((key) => !isTelemetryAttributeAllowed(key))
  check(
    '正控：逐道状态属性键**全部**过遥测白名单（不过白名单就会在导出时被过滤掉 ⇒ 面板上永远看不到）',
    badKeys.length === 0 && Object.keys(attributes).length >= 8,
    `${String(Object.keys(attributes).length)} 个键，越界 ${badKeys.join(',') || '0'} 个`
  )
  check(
    '负控：属性里**没有**回复正文（值只可能是枚举标签与计数）',
    Object.values(attributes).every(
      (value) => typeof value === 'number' || ['not_run', 'passed', 'triggered'].includes(String(value))
    ),
    Object.entries(attributes)
      .map(([k, v]) => `${k}=${String(v)}`)
      .slice(0, 4)
      .join(' ')
  )

  check(
    '★ 计数自检：**缺报告**必须被报出来（四道守卫少一道 ⇒ 观测不完整，不是"那一道没问题"）',
    missingReplyGuards(reports).length === 0 &&
      missingReplyGuards(reports.filter((r) => r.name !== 'search_need')).join(',') === 'search_need',
    '缺 search_need 时被指名'
  )
  check(
    '★ 负控：**一份报告都没有** ⇒ 四道全部算"缺报告"（空集不得显示成"全部通过"）',
    missingReplyGuards([]).length === REPLY_GUARD_NAMES.length,
    `${String(missingReplyGuards([]).length)} 道缺报告`
  )
  check(
    '★ 负控：违规（触发）与"观测缺失"是**两个不同的数**（不许合成一个分）',
    summarizeReplyGuards(reports).triggered !== summarizeReplyGuards(reports).notRun,
    'triggered=1 / notRun=2'
  )
}

// ===========================================================================
// M6.1 WP4 / ADR-055 D-55d：运行期「生产装配 ≡ 受测装配」三读数（正控/负控/恢复）
// ===========================================================================
/*
 * 本段只判**读数器**：给它注入好的 / 坏的 trace 事实，它必须**因预期原因**报红。
 * 真实读数由生产装配跑出来的 run 提供（WP5/WP6 的 Live 档），不许拿本段冒充。
 */
section('M6.1 WP4 · D-55d 运行期三读数：端口缺失 / 开关未消费 / 结果没进下游')

{
  const healthyTurn: RuntimeTurnEvidence = {
    scenarioId: 'S-healthy',
    expectations: [
      { capability: 'recall', expect: 'must_fire', minDownstream: 1 },
      { capability: 'record_status', expect: 'must_fire' },
      { capability: 'reply_guards', expect: 'must_fire' },
      { capability: 'memory_write', expect: 'must_fire' },
      /* 这一轮**没有**动作与摘要 ⇒ 声明成"不该发生"（同样要有触发条件，否则安静不算证据） */
      { capability: 'action', expect: 'not_expected' },
      { capability: 'rollup', expect: 'not_expected' },
    ],
    stepKinds: [
      'memory_explicit_write',
      'context_compile',
      'memory_recall',
      'memory_record_status',
      'model_generate',
      'reply_guard',
      'output_validate',
    ],
    stepAttributes: [
      {
        kind: 'memory_record_status',
        attributes: { outcome: 'included', reason_code: '(none)', included_count: 1 },
      },
      { kind: 'reply_guard', attributes: { guard_count: 4, guard_triggered_count: 0 } },
    ],
    selectedMemoryIds: ['mem:1'],
    intendedSelectedIds: ['mem:1'],
    contextSectionIds: ['memory-recall', 'memory-record-status'],
    droppedSectionIds: [],
    memoryWrite: { ok: true, statusChanged: true },
    replyGuards: [
      { name: 'memory_truth', state: 'passed', reasons: [] },
      { name: 'action_truth', state: 'not_run', reasons: ['no_action_results'] },
      { name: 'evidence_truth', state: 'not_run', reasons: ['no_search_this_turn'] },
      { name: 'search_need', state: 'not_run', reasons: ['no_search_need_judgment'] },
    ],
  }

  const positive = readAssemblyRuntime([healthyTurn])
  check(
    '正控：健康一轮 ⇒ 三读数齐、零缺陷、verdict = PASS',
    positive.verdict === 'PASS' && positive.problems.length === 0,
    `verdict=${positive.verdict} problems=${String(positive.problems.length)}`
  )
  check(
    '正控：逐能力给出三读数（端口 / 开关 / 实际入模）+ "是否可作证据"',
    positive.readings.length === ASSEMBLY_CAPABILITIES.length * 1 - 0 &&
      positive.readings.every((reading) => reading.triggerDeclared) &&
      positive.readings.some((reading) => reading.capability === 'recall' && reading.portWired === true),
    `${String(positive.readings.length)} 条读数`
  )

  /* 负控①：端口缺失（状态行**具名**说 port_not_wired） */
  const portMissing = readAssemblyRuntime([
    {
      ...healthyTurn,
      stepAttributes: [
        {
          kind: 'memory_record_status',
          attributes: { outcome: 'included', reason_code: 'not_searched:port_not_wired' },
        },
        { kind: 'reply_guard', attributes: {} },
      ],
      stepKinds: healthyTurn.stepKinds.filter((kind) => kind !== 'memory_recall'),
    },
  ])
  check(
    '★ 负控①：端口缺失 ⇒ 必须因 `port_missing` 报红（而不是静默算通过）',
    portMissing.verdict === 'FAIL' &&
      portMissing.problems.some(
        (problem) => problem.kind === 'port_missing' && problem.capability === 'recall'
      ),
    portMissing.problems.map((p) => p.kind).join(',')
  )

  /* 负控②：开关未被消费 */
  const flagOff = readAssemblyRuntime([
    {
      ...healthyTurn,
      stepAttributes: [
        {
          kind: 'memory_record_status',
          attributes: { outcome: 'included', reason_code: 'not_searched:flag_off' },
        },
        { kind: 'reply_guard', attributes: {} },
      ],
      stepKinds: healthyTurn.stepKinds.filter((kind) => kind !== 'memory_recall'),
    },
  ])
  check(
    '★ 负控②：端口在、开关把它关掉 ⇒ 必须因 `flag_not_consumed` 报红',
    flagOff.verdict === 'FAIL' &&
      flagOff.problems.some((problem) => problem.kind === 'flag_not_consumed'),
    flagOff.problems.map((p) => p.kind).join(',')
  )

  /* 负控③：结果没进后续链路（选了但没入模 / 写了但没落步骤） */
  const notInDownstream = readAssemblyRuntime([
    {
      ...healthyTurn,
      stepKinds: healthyTurn.stepKinds.filter((kind) => kind !== 'memory_explicit_write'),
      selectedMemoryIds: [],
      contextSectionIds: ['memory-record-status'],
      memoryWrite: { ok: true, statusChanged: true },
    },
  ])
  check(
    '★ 负控③：结果没进后续链路 ⇒ 必须因 `result_not_in_downstream` 报红（选了没入模 / 写了没落步骤）',
    notInDownstream.verdict === 'FAIL' &&
      notInDownstream.problems.filter((problem) => problem.kind === 'result_not_in_downstream')
        .length >= 2,
    notInDownstream.problems.map((p) => `${p.capability}:${p.kind}`).join(',')
  )

  /* 负控④：没有预先声明触发条件 ⇒ 安静轮次**不能**算证据 */
  const undeclared = readAssemblyRuntime([{ ...healthyTurn, expectations: [] }])
  check(
    '★ 负控④：没声明"应该触发什么" ⇒ 该轮不产生证据（verdict = MEASUREMENT INVALID，不是 PASS）',
    undeclared.verdict === 'MEASUREMENT INVALID' &&
      undeclared.problems.some((problem) => problem.kind === 'trigger_not_declared'),
    `verdict=${undeclared.verdict}`
  )
  check(
    '★ 计数自检：**空运行** ⇒ MEASUREMENT INVALID（0 轮不得显示成"全都没问题"）',
    readAssemblyRuntime([]).verdict === 'MEASUREMENT INVALID',
    'MEASUREMENT INVALID'
  )

  /* 恢复：把注入项放回 ⇒ 重新 PASS */
  const restored = readAssemblyRuntime([healthyTurn])
  check(
    '★ 恢复：把注入项放回 ⇒ 重新 PASS（正控/负控/恢复三段齐了）',
    restored.verdict === 'PASS' && restored.problems.length === 0,
    `verdict=${restored.verdict}`
  )

  /* 静态表也要覆盖新接线（D-55g 的 replyGuards 端口） */
  const sources = readAssemblySources(ROOT)
  const wiringProblems = checkAssemblyEquivalence(sources)
  check(
    '正控（静态）：生产装配的接线表在当前树上零问题（含 M6.1 WP4 新增的 replyGuards）',
    wiringProblems.length === 0 &&
      CAPABILITY_WIRINGS.some((wiring) => wiring.capability.includes('replyGuards')),
    wiringProblems.map((problem) => `${problem.capability}:${problem.kind}`).join(' ') || '零问题'
  )
}

// ===========================================================================
// M6.1 WP6 · 长对话轨迹：生成器不变量 / 候选扫描核心 / 序号核验（全离线 · 纯模块）
// ===========================================================================

section('M6.1 WP6 · 长轨迹生成器：冻结不变量逐条穷举（3×500 轮）')

const longTrajectories = LONG_TRAJECTORY_IDS.map((id) => buildLongTrajectory(id))
const longInvariantReports = new Map(longTrajectories.map((traj) => [traj.id, checkTrajectoryInvariants(traj)]))

for (const traj of longTrajectories) {
  const report = longInvariantReports.get(traj.id)!
  check(
    `正控（WP6 ${traj.id}）：结构不变量全部成立（恰 500 轮 · 检查点 1/50/100/200/300/400/500 · 相邻不重复 · 探针规格完备）`,
    report.ok &&
      report.turns === LONG_TRAJECTORY_TURNS &&
      report.checkpoints.join(',') === LONG_CHECKPOINTS.join(','),
    report.problems.length === 0
      ? `${traj.id}：${String(report.turns)} 轮 · 探针 ${String(report.probeCount)} · 诱导 ${String(report.inducementCount)} · 更正 ${String(report.correctionCount)} · 遗忘 ${String(report.forgetCount)}`
      : report.problems.join('；')
  )
}

check(
  '正控（WP6）：三条轨迹的冻结位置计数恰为设计值（V1 纯净 0 诱导；V2 5 诱导+3 更正+1 遗忘；V3 1 假预设）',
  longInvariantReports.get('V1')!.inducementCount === 0 &&
    longInvariantReports.get('V1')!.correctionCount === 0 &&
    longInvariantReports.get('V1')!.forgetCount === 0 &&
    longInvariantReports.get('V2')!.inducementCount === 5 &&
    longInvariantReports.get('V2')!.correctionCount === 3 &&
    longInvariantReports.get('V2')!.forgetCount === 1 &&
    longInvariantReports.get('V3')!.inducementCount === 1 &&
    longInvariantReports.get('V1')!.probeCount === 7 &&
    longInvariantReports.get('V2')!.probeCount === 12 &&
    longInvariantReports.get('V3')!.probeCount === 8,
  LONG_TRAJECTORY_IDS.map((id) => `${id}:${String(longInvariantReports.get(id)!.probeCount)}探针/${String(longInvariantReports.get(id)!.inducementCount)}诱导`).join(' · ')
)

check(
  '负控（WP6 V1 主题纯度）：整条 500 轮里**零** correction / forget / inducement / false_presupposition（纯净性是 V1 的主题定义）',
  longTrajectories[0]!.turns.every(
    (turn) => turn.kind !== 'correction' && turn.kind !== 'forget' && turn.kind !== 'inducement' && turn.kind !== 'false_presupposition'
  ),
  'V1 = 普通连续性：只许 fact_setup / fact_followup / casual / fact_reference / checkpoint_probe / first_turn_probe'
)

check(
  '正控（WP6 V2 操作位置冻结）：更正恰在 t60/t140/t280 · 遗忘恰在 t220 · 诱导恰在 t90/t170/t260/t350/t450',
  (() => {
    const v2 = longTrajectories[1]!
    const at = (kind: string) => v2.turns.filter((turn) => turn.kind === kind).map((turn) => turn.index)
    return (
      at('correction').join(',') === '60,140,280' &&
      at('forget').join(',') === '220' &&
      at('inducement').join(',') === '90,170,260,350,450'
    )
  })(),
  'V2 冻结参数（Freeze-Sheet §1）；位置漂移 = 换了实验'
)

check(
  '正控（WP6 V2 因果先后）：每条更正/遗忘的目标槽位都**先建立后操作**（t60>t2 · t140>t4 · t280>t12 · t220>t14）',
  (() => {
    const v2 = longTrajectories[1]!
    const textAt = (index: number) => v2.turns[index - 1]!.userText
    return (
      textAt(2).includes('不吃辣') && textAt(60).includes('吃辣') && 60 > 2 &&
      textAt(4).includes('汉语言文学') && textAt(140).includes('历史学') && 140 > 4 &&
      textAt(12).includes('书店') && textAt(280).includes('咖啡馆') && 280 > 12 &&
      textAt(14).includes('不喝咖啡') && textAt(220).includes('忘掉') && 220 > 14
    )
  })(),
  '「先建立后操作」是纠正/遗忘判定的前提；反序 = 探针在测一个不存在的前提'
)

check(
  '正控（WP6 V3 冲突对与恢复主题）：冲突对 t30(苏州)→t120(南京) 有序 · 自我更正 t250 · 假预设恰在 t330',
  (() => {
    const v3 = longTrajectories[2]!
    const textAt = (index: number) => v3.turns[index - 1]!.userText
    return (
      textAt(30).includes('苏州') && textAt(120).includes('南京') && 120 > 30 &&
      textAt(250).includes('没养过狗') &&
      v3.turns.filter((turn) => turn.kind === 'false_presupposition').map((turn) => turn.index).join(',') === '330' &&
      v3.turns.filter((turn) => turn.kind === 'conflict_statement').map((turn) => turn.index).join(',') === '30,120'
    )
  })(),
  'V3 = 来源冲突/恢复：冲突对无更正标记（测"以最新为准"），假预设从未建立过（测拒绝）'
)

check(
  '正控（WP6 回忆探针有据）：每条 recall/recall_current/attribution 探针的 expectedPoints 都能在**更早**的轮次原话里找到',
  (() => {
    const problems: string[] = []
    for (const traj of longTrajectories) {
      for (const turn of traj.turns) {
        if (turn.probe === undefined) continue
        if (turn.probe.expect !== 'recall' && turn.probe.expect !== 'recall_current' && turn.probe.expect !== 'attribution') continue
        for (const point of turn.probe.expectedPoints) {
          const established = traj.turns.some((prior) => prior.index < turn.index && prior.userText.includes(point))
          if (!established) problems.push(`${turn.probe.probeId} 的要点「${point}」没有更早的建立轮`)
        }
      }
    }
    return problems.length === 0
  })(),
  '要点无据 = 探针在测她"猜中"，不是测她"记住"'
)

check(
  '正控（WP6 确定性）：同一轨迹连建两次 ⇒ 逐字相同（生成器无随机源 ⇒ 可重放、可审计）',
  (() => {
    for (const id of LONG_TRAJECTORY_IDS) {
      const a = buildLongTrajectory(id)
      const b = buildLongTrajectory(id)
      if (JSON.stringify(a) !== JSON.stringify(b)) return false
    }
    return true
  })(),
  '确定性是"剧本指纹进 manifest"的前提；非确定性生成器会让两次运行不可比'
)

check(
  '正控（WP6 填充不退化）：三条轨迹的 casual 轮互不相同（相位错开）且单轨迹内相邻轮永不重复',
  (() => {
    for (const traj of longTrajectories) {
      for (let i = 1; i < traj.turns.length; i += 1) {
        if (traj.turns[i]!.userText === traj.turns[i - 1]!.userText) return false
      }
    }
    const casualOf = (id: number) => longTrajectories[id]!.turns.filter((turn) => turn.kind === 'casual').map((turn) => turn.userText)
    const c1 = casualOf(0), c2 = casualOf(1), c3 = casualOf(2)
    return c1.length > 400 && c2.length > 400 && c3.length > 400 && JSON.stringify(c1) !== JSON.stringify(c2) && JSON.stringify(c1) !== JSON.stringify(c3)
  })(),
  '"同一句循环 500 次"是被计划书点名禁止的退化形态'
)

check(
  '正控（WP6 冻结单在树上）：M6.1-WP6-Freeze-Sheet.md 存在且记录三条裁定（F-1/F-2/F-3）',
  (() => {
    const sheetPath = join(ROOT, 'docs', 'm6.1', 'M6.1-WP6-Freeze-Sheet.md')
    if (!existsSync(sheetPath)) return false
    const text = readFileSync(sheetPath, 'utf8')
    return text.includes('F-1') && text.includes('F-2') && text.includes('F-3') && text.includes('FROZEN')
  })(),
  '冻结单是 WP6 的参数权威源；它不在树上 = 运行器的指纹对象不存在'
)

section('M6.1 WP6 · 候选扫描核心：漏检自证（正控必响 / 负控必静 / 计数自检）')

const scanSelfProof = evaluateScanSelfProof()
check(
  '★ 正控（WP6 扫描自证）：WP5 已知 alert 引文 100% 被抓 + 纯确认回复 0 候选 + measured>0',
  scanSelfProof.valid &&
    scanSelfProof.measured > 0 &&
    scanSelfProof.positivesCaught === scanSelfProof.positivesTotal &&
    scanSelfProof.negativesClean === scanSelfProof.negativesTotal,
  `正控 ${String(scanSelfProof.positivesCaught)}/${String(scanSelfProof.positivesTotal)} · 负控 ${String(scanSelfProof.negativesClean)}/${String(scanSelfProof.negativesTotal)} · measured ${String(scanSelfProof.measured)}`
)

check(
  '正控（WP6 形态族对准）：A-06 编造引语→backward_attribution · RCE-02 虚构复数→plurality · B-05「又」族→again_family · C-02/A-03 时间线→timeline',
  (() => {
    const familiesOf = (quote: string) => extractCandidatesFromSentence(quote)?.families ?? []
    return (
      familiesOf('你说过让我详细解释你。').includes('backward_attribution') &&
      familiesOf('你说过的又不止一件。').includes('plurality') &&
      familiesOf('别又拖到最后一天。').includes('again_family') &&
      familiesOf('前两天还说不吃，转头又更正成吃。').includes('timeline') &&
      familiesOf('本科生。你前几天说的。').includes('timeline')
    )
  })(),
  '正控引文来自 WP5 判定轮的真实 alert（收口报告 §2.2–§2.5）；抓不到 = 对已知形态漏检'
)

check(
  '负控（WP6 扫描器没有退化成全文标记器）：六条纯确认/日常回复全部 0 候选',
  SCAN_NEGATIVE_CONTROLS.every((control) => extractAssertionCandidates(control).length === 0) &&
    SCAN_POSITIVE_CONTROLS.length === 8 &&
    SCAN_NEGATIVE_CONTROLS.length === 6,
  '误报的代价：判定预算被无关句挤占 + 人审包混入噪音'
)

check(
  '正控（WP6 确定性抽样）：同种子同池 ⇒ 同子集；池不超上限 ⇒ 全保留且 overflow=0；超上限 ⇒ 恰留 cap 条',
  (() => {
    const pool = Array.from({ length: 100 }, (_, i) => `候选${String(i)}`)
    const a = deterministicSample(pool, 60, 'aabbccdd00112233')
    const b = deterministicSample(pool, 60, 'aabbccdd00112233')
    const c = deterministicSample(pool, 60, 'ff00ff00ff00ff00')
    const small = deterministicSample(pool.slice(0, 10), 60, 'aabbccdd00112233')
    return (
      JSON.stringify(a.kept) === JSON.stringify(b.kept) &&
      a.overflow === 40 && a.kept.length === 60 &&
      JSON.stringify(a.kept) !== JSON.stringify(c.kept) &&
      small.kept.length === 10 && small.overflow === 0
    )
  })(),
  `上限 ${String(LONG_CANDIDATE_JUDGE_CAP)}/轨迹（Freeze-Sheet §3）；抽样不确定 = 溢出时不可复现`
)

section('M6.1 WP6 · 序号核验（F-2 的承载判据；纯函数正负控）')

check(
  '★ 正控（WP6 序号核验）：连续读数（每完成轮 +2 事件 · 末号=总数 · 跨检查点递增）⇒ 0 异常',
  (() => {
    const readings: SequenceCheckpointReading[] = [
      { checkpoint: 1, completedTurns: 1, failedTurns: 0, conversationEvents: 2, latestSequence: 2 },
      { checkpoint: 50, completedTurns: 50, failedTurns: 0, conversationEvents: 100, latestSequence: 100 },
      { checkpoint: 100, completedTurns: 100, failedTurns: 0, conversationEvents: 200, latestSequence: 200 },
      { checkpoint: 200, completedTurns: 200, failedTurns: 0, conversationEvents: 400, latestSequence: 400 },
      { checkpoint: 300, completedTurns: 300, failedTurns: 0, conversationEvents: 600, latestSequence: 600 },
      { checkpoint: 400, completedTurns: 400, failedTurns: 0, conversationEvents: 800, latestSequence: 800 },
      { checkpoint: 500, completedTurns: 500, failedTurns: 0, conversationEvents: 1000, latestSequence: 1000 },
    ]
    const verdict = verifySequenceContiguity(readings)
    return verdict.ok && verdict.anomalies.length === 0
  })(),
  'spawn-per-turn 500 次重启后序号仍连续 = "续接的作用域与序号"成立'
)

check(
  '★ 正控（WP6 序号核验 · 带缺口）：V2 实测形态（末号≈3×完成轮 > 总数=2×完成轮）⇒ **不是**异常（序号是共享计数器，缺口是设计内）',
  (() => {
    /* V2 正式读数的真实形态：每轮约 3 个序号、2 行会话事件（非会话路径也消耗序号） */
    const readings: SequenceCheckpointReading[] = [
      { checkpoint: 1, completedTurns: 1, failedTurns: 0, conversationEvents: 2, latestSequence: 2 },
      { checkpoint: 50, completedTurns: 50, failedTurns: 0, conversationEvents: 100, latestSequence: 152 },
      { checkpoint: 100, completedTurns: 99, failedTurns: 0, conversationEvents: 198, latestSequence: 302 },
      { checkpoint: 200, completedTurns: 198, failedTurns: 1, conversationEvents: 397, latestSequence: 601 },
      { checkpoint: 300, completedTurns: 298, failedTurns: 1, conversationEvents: 597, latestSequence: 901 },
      { checkpoint: 400, completedTurns: 398, failedTurns: 1, conversationEvents: 797, latestSequence: 1201 },
      { checkpoint: 500, completedTurns: 497, failedTurns: 3, conversationEvents: 997, latestSequence: 1501 },
    ]
    const verdict = verifySequenceContiguity(readings)
    return verdict.ok && verdict.anomalies.length === 0
  })(),
  '原判据"末号=总数"在 V2 上把 6 个检查点全误报成"断裂"——量具错误已修（冻结单 §11）；此锁防回退'
)

check(
  '★ 负控（WP6 序号核验）：重置 / 计数器落后 / 计数器回退 / 越界 / 读数缺失 各自必须响',
  (() => {
    const reset = verifySequenceContiguity([
      { checkpoint: 100, completedTurns: 100, failedTurns: 0, conversationEvents: 200, latestSequence: 302 },
      { checkpoint: 200, completedTurns: 200, failedTurns: 0, conversationEvents: 4, latestSequence: 6 },
    ])
    const counterBehind = verifySequenceContiguity([
      { checkpoint: 50, completedTurns: 50, failedTurns: 0, conversationEvents: 100, latestSequence: 97 },
    ])
    const counterReset = verifySequenceContiguity([
      { checkpoint: 100, completedTurns: 100, failedTurns: 0, conversationEvents: 200, latestSequence: 302 },
      { checkpoint: 200, completedTurns: 200, failedTurns: 0, conversationEvents: 400, latestSequence: 301 },
    ])
    const outOfRange = verifySequenceContiguity([
      { checkpoint: 50, completedTurns: 50, failedTurns: 0, conversationEvents: 137, latestSequence: 152 },
    ])
    const missing = verifySequenceContiguity([
      { checkpoint: 50, completedTurns: 50, failedTurns: 0, conversationEvents: -1, latestSequence: -1 },
    ])
    const seqUnparsed = verifySequenceContiguity([
      { checkpoint: 50, completedTurns: 50, failedTurns: 0, conversationEvents: 100, latestSequence: -1 },
    ])
    const failureTolerant = verifySequenceContiguity([
      { checkpoint: 50, completedTurns: 49, failedTurns: 1, conversationEvents: 99, latestSequence: 150 },
    ])
    return (
      !reset.ok && reset.anomalies.length > 0 &&
      !counterBehind.ok &&
      !counterReset.ok &&
      !outOfRange.ok &&
      !missing.ok &&
      !seqUnparsed.ok &&
      failureTolerant.ok
    )
  })(),
  '失败轮容差：完成 49 + 失败 1 ⇒ 事件 99（2×49+1）合法；六种真异常（含"计数器落后/回退"）一种都不能漏'
)

check(
  '★ 正控（WP6 kernel-status 解析）：真实输出格式（padStart(4) 的「#  12 [」）⇒ 总数与末号都解析到',
  (() => {
    const raw = [
      '## 事实账本 conversation_events（6 条）',
      '  #   1 [user/message] 我们刚才聊到哪儿了？',
      '  #   2 [assistant/message] 我们才刚开始聊……',
      '  #   3 [user/message] 记住：我在江城大学读书。',
      '  #   4 [assistant/message] 好，我记下了。',
      '  #   5 [user/message] 学校不大，但绿化特别好。',
      '  #   6 [assistant/message] 听起来是个舒服的地方。',
      '  · #3 某某事实（5 条语句）',
    ].join('\n')
    const parsed = parseKernelStatus(raw)
    return parsed.conversationEvents === 6 && parsed.latestSequence === 6
  })(),
  '第一版正则 `#(\\d+) \\[` 在 padStart 的空格上匹配零条 ⇒ 序号核验空转（§6.8 形态）；此锁防回归'
)

check(
  '★ 负控（WP6 kernel-status 解析）：格式漂移 / 空输出 / 无事件行 ⇒ 读数缺失（-1），不得伪装成 0',
  (() => {
    const empty = parseKernelStatus('')
    const drifted = parseKernelStatus('## 事实账本 conversation_events : 6 条') /* 冒号格式 = 不是总数行 */
    const noEvents = parseKernelStatus('## 事实账本 conversation_events（6 条）') /* 总数在但没有事件行 */
    const unpadded = parseKernelStatus('## 事实账本 conversation_events（3 条）\n  #3 [user/message] x\n  #1 [user/message] y\n  #2 [user/message] z')
    return (
      empty.conversationEvents === -1 && empty.latestSequence === -1 &&
      drifted.conversationEvents === -1 &&
      noEvents.conversationEvents === 6 && noEvents.latestSequence === -1 &&
      unpadded.latestSequence === 3
    )
  })(),
  '读数缺失必须以 -1 如实呈现（verifySequenceContiguity 会把它记为异常），绝不折算成 0'
)

// ===========================================================================
// 证据
// ===========================================================================

const evidence = {
  schemaVersion: 'm6.1-component@1',
  testId: 'M6.1 / L1 component tests (offline · no DB · no key · no model · no real DB)',
  scope: 'M6.1 判据层：清单校验 / 运行目录 / 语料规则 / 泄漏检测 / 入口守卫（纯函数 + 临时目录）',
  note:
    '判据的期望值**独立写死**在本文件里（标签集 / 类别集 / 每类下限 / 门的接受判决 / 拒绝码）。' +
    '证据里**没有时钟字段** ⇒ 重复运行逐字节相同。本门不碰数据库、不联网、不调模型。',
  verdict: failed > 0 ? 'FAIL' : 'PASS',
  passed,
  failed,
  measurementInvalid: 0,
  failures,
  checks,
  counters: {
    checks: checks.length,
    corpusItemsInFixture: LEGAL_CORPUS.length,
    categoriesCovered: countByCategory(LEGAL_CORPUS).filter((entry) => entry.total > 0).length,
    gateSpecs: M6_1_GATE_SPECS.length,
    manifestFields: M6_1_MANIFEST_REQUIRED_FIELDS.length,
  },
  versions: {
    contract: M6_1_CONTRACT_VERSION,
    corpus: M6_1_CORPUS_VERSION,
    instrument: M6_1_INSTRUMENT_VERSION,
  },
  instrument: {
    mode: '绝对分类（单条回复 + 实际证据），**不是**对比式 —— 立案 §3② 的旧探测器错因',
    defenses: {
      positionBias: 'not-applicable（绝对分类没有"先呈现谁"这一自由度）',
      equivalents: ['a==b 一致性', '成对一致性（顺序/文风不得改变判定）'],
    },
    validityCriteriaStatus: INSTRUMENT_VALIDITY_CRITERIA.status,
    validityCriteria: INSTRUMENT_VALIDITY_CRITERIA,
    provenByThisGate: [
      '四种解析失败各自具名（空输出 / 非 JSON / 形状坏 / 标签越界）—— 都不算"判对"',
      '标准未批准时只能是 INCONCLUSIVE，**不可能** VALID（阈值分两次冻结）',
      '全部判安全 / 全部判编造 / 仅按关键词判 / 空结果 / 形状坏 ⇒ 五种假量具逐一被判 INVALID',
      '分母为 0 时 recall 与误报率是 null（不是 0、也不是 1）',
      'a==b 被判得不一致时度量层必须响；不注入时两条防线回到 1.0',
      '判定提示不依赖期望标签（换一套标签，提示逐字相同）',
    ],
    notProvenByThisGate: [
      '**没有任何真实语义读数**：本门用的是夹具判定器，它证明"判据会响"，不证明真实 judge 判得对。',
      '真实 judge 的读数属于 WP2 的 live 档；在其跑出来之前，量具对真实数据的有效性**未知**。',
      '量具若与**被测端**使用同一模型，则误差相关，**不能**称独立验证（计划书 §WP2）。',
    ],
  },
  frozen: {
    labels: MEMORY_ASSERTION_LABELS,
    alertLabels: ALERT_LABELS,
    categories: CATEGORY_IDS,
    minCheckpointsPerCategory: MIN_CHECKPOINTS_PER_CATEGORY,
    minTotalCheckpoints: MIN_TOTAL_CHECKPOINTS,
    liveSuites: M6_1_LIVE_SUITES.map((entry) => ({ name: entry.name, implemented: entry.implemented })),
  },
  wp6: {
    turnsPerTrajectory: LONG_TRAJECTORY_TURNS,
    checkpoints: LONG_CHECKPOINTS,
    trajectories: LONG_TRAJECTORY_IDS.map((id) => {
      const report = longInvariantReports.get(id)!
      return {
        id,
        probeCount: report.probeCount,
        inducementCount: report.inducementCount,
        correctionCount: report.correctionCount,
        forgetCount: report.forgetCount,
        invariantsOk: report.ok,
      }
    }),
    scanSelfProof: {
      valid: scanSelfProof.valid,
      measured: scanSelfProof.measured,
      positivesCaught: scanSelfProof.positivesCaught,
      positivesTotal: scanSelfProof.positivesTotal,
      negativesClean: scanSelfProof.negativesClean,
      negativesTotal: scanSelfProof.negativesTotal,
    },
    candidateJudgeCap: LONG_CANDIDATE_JUDGE_CAP,
    notProvenByThisGate: [
      '本门锁的是**剧本结构与量具判据**：它不证明任何真实 500 轮的行为读数（那属于正式运行 + 人审）。',
      '扫描器的正控引文是 WP5 已知形态的样本，不是全空间证明：未知形态仍可能漏检（人审窗口抽样是第二道网）。',
      '序号核验的输入形状来自 --kernel-status 的解析；解析器本身由运行期读数验证，本门只锁纯逻辑。',
    ],
  },
  knownLimitations: [
    '本门只证明**判据会响**：它不证明任何真实回复被正确判定（那属于 WP2 量具有效性与 WP5/6 行为门）。',
    '合法底稿是**合成**的，不是任何真实对话；真实回归材料在 WP1 的语料门里单独处理。',
    '`wp1-corpus` 门的接受判决只有 FROZEN ⇒ 真人审核之前，汇总按设计**不可能**是 PASS。',
    '量具有效性标准（INSTRUMENT_VALIDITY_CRITERIA）仍是 PROPOSED（CD-7）⇒ 现在**不可能**判出 VALID。',
    '与**被测端**同模型的误差相关性未测；不能称独立验证。',
  ],
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'component.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\nM6.1 L1 部件级测试：${passed} 通过 / ${failed} 失败`)
console.log('  证据：artifacts/m6.1/component.json')
process.exit(failed > 0 ? 1 : 0)
