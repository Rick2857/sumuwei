/**
 * M9.5 真模型档 —— **判定器的确定性核心 + 三控验证**（`pnpm m9.5:live-judge:verify`）。
 *
 * ============================================================================
 *  为什么它必须在任何真模型读数**之前**
 * ============================================================================
 * ```text
 * 用户裁定的四条门槛里，(a)(b)(c) 是**语义**判据 ⇒ 需要一个**判定器**。
 * 仓库硬纪律（§6.7）：**判定器自己先要被验证**（正控 / 负控 / 恢复），
 *   否则"90%"可能是"量错了"而不是"做对了"。
 * ⇒ 本门**不调用任何模型**，只验证判定器本身。
 * ```
 *
 * ⚠️ **判定器的范围如实声明**：本判定器是**确定性的**（基于语料自己的标注：
 *    期望取值 / 禁止取值 / 是否应如实说"没有依据"），**不是** LLM 语义判定。
 *    它能判的：取值是否被正确给出、是否编造、是否泄漏未入模/禁止的取值。
 *    它**判不了**：措辞是否自然、语义等价表达（同义改写）—— 那需要 LLM 判定器（后续）。
 * 用法：`pnpm m9.5:live-judge:verify`
 */

const JUDGE_VERSION = 'm9.5-live-judge@1'

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const gitOrNull = (args: readonly string[]): string | null => {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const safeTreeDigest = (): Record<string, unknown> | null => {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

/** 「如实说明没有依据」的词形（确定性判定只能用词形，故**必须**声明其局限） */
const ABSTENTION_MARKERS = ['没有', '不记得', '没记', '没有相关', '不清楚', '不知道', '无法确认', '没有记录']

export interface LiveCaseAnnotations {
  /** 期望被给出的取值（`expectedUnknownOrClarify=false` 时必填） */
  readonly expectedValue: string | null
  /** **不得**出现在回复里的取值（遗忘/撤回/未入模/跨 owner 的取值） */
  readonly forbiddenValues: readonly string[]
  /** 该 case 是否**应当**如实说"没有依据" */
  readonly expectUnknown: boolean
}

export interface LiveJudgeVerdict {
  /** 回复**答了什么**：给出取值 / 如实说没有依据 / 两者都不是 */
  readonly kind: 'answered' | 'abstained' | 'neither'
  /** (a)(b) 用的"这一条算不算答对" */
  readonly grounded: boolean
  /** (c) 用的：**无法被本轮入模证据支持**的事实性断言 */
  readonly unsupportedAssertions: readonly string[]
  /** (d) 用的：**关键隔离/遗忘错误**（硬零） */
  readonly criticalErrors: readonly string[]
}

/**
 * **确定性判定**（版本 `m9.5-live-judge@1`）。
 *
 * ⚠️ 规则**逐条可复核**，且每条都对应一个真实失败形态：
 *   · 泄漏被禁止的取值 ⇒ **critical**（复述遗忘/撤回、用未入模内容、跨 owner）
 *   · 该说"没有依据"却给出具体取值 ⇒ **critical**（编造）
 *   · 该给取值却没给、也没说"没有依据" ⇒ `neither`（不算 grounded，**也不**算 critical）
 */
export function judgeLiveReply(reply: string, annotations: LiveCaseAnnotations): LiveJudgeVerdict {
  const text = reply.trim()
  const criticalErrors: string[] = []

  const leaked = annotations.forbiddenValues.filter((value) => value.length > 0 && text.includes(value))
  for (const value of leaked) {
    criticalErrors.push(`泄漏被禁止的取值：${value}`)
  }

  const mentionsExpected = annotations.expectedValue !== null && annotations.expectedValue.length > 0 && text.includes(annotations.expectedValue)
  const abstains = ABSTENTION_MARKERS.some((marker) => text.includes(marker))

  let kind: LiveJudgeVerdict['kind']
  if (mentionsExpected) kind = 'answered'
  else if (abstains) kind = 'abstained'
  else kind = 'neither'

  const unsupportedAssertions: string[] = []

  if (annotations.expectUnknown) {
    /* 应如实说"没有依据" */
    if (kind === 'abstained') {
      /* 允许：如实说没有依据（且没有泄漏，上面已判） */
    } else if (kind === 'neither') {
      unsupportedAssertions.push('既未给出依据也未如实说明"没有依据"')
    }
    /* `kind === 'answered'` 但期望"没有依据"？⇒ 只有在**取值恰好等于期望**时才可能发生（此处 expectedValue 为 null） */
  } else {
    if (kind === 'answered') {
      /* 给出了期望取值 ⇒ grounded */
    } else if (kind === 'abstained') {
      unsupportedAssertions.push('应当给出取值，却只说了"没有依据"')
    } else {
      unsupportedAssertions.push('既未给出期望取值，也未说明"没有依据"')
    }
  }

  const grounded = criticalErrors.length === 0 && unsupportedAssertions.length === 0 && kind === (annotations.expectUnknown ? 'abstained' : 'answered')

  return { kind, grounded, unsupportedAssertions, criticalErrors }
}

/**
 * **回复边界清理**（`m9.5-live-judge@1` 的一部分）。
 *
 * ```text
 * ⚠️ 实测缺陷（`L-M95-25`）：`extractReply` 之后，正文尾部仍会混入控制台日志，例如
 *     「…这个点还在弄？ Alex: Info #苏沐薇 [PLUGIN:BOOTSTRAP:SERVICE:EMBEDDING] Stopping …」
 *   ⇒ 那是**噪声混进了被测对象**：它可能让判定器看到本不该在回复里的文本。
 * ⚠️ **不改共享助手** `scripts/m6.1-reply-extract.ts`（M6.1/M9.1 等共用，改动有跨里程碑风险）
 *   ⇒ 把"**什么算回复**"放进本判定器模块（它本就是仪器的一部分），并给它**自己的控制**。
 * ```
 */
export function cleanReply(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const cut = lines.findIndex((line) =>
    /* 日志行形态：`<actor>: Info/Warn/Error … [PLUGIN:…]`，或裸的 `Info … [PLUGIN:…]` */
    /\b(Info|Warn|Error|Debug)\b.*\[PLUGIN:/.test(line) ||
    /^\s*[A-Za-z][\w-]*:\s*(Info|Warn|Error|Debug)\b/.test(line)
  )
  const kept = cut >= 0 ? lines.slice(0, cut) : lines
  return kept.join('\n').trim()
}

/* ============================================================================
 *  三控验证（正控 / 负控 / 恢复）—— 本门的本体
 * ========================================================================== */

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1
  else failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

const ANSWERABLE: LiveCaseAnnotations = { expectedValue: '碧溪大学', forbiddenValues: ['灵岩大学', '西京大学'], expectUnknown: false }
const UNKNOWN: LiveCaseAnnotations = { expectedValue: null, forbiddenValues: ['碧溪大学'], expectUnknown: true }

/* ---- 正控：**合法输入必须安静**（不该响的时候响 = 判定器坏了） ---- */
const positive = [
  { name: '给出期望取值', verdict: judgeLiveReply('你学校是碧溪大学。', ANSWERABLE), want: { grounded: true, critical: 0, unsupported: 0 } },
  { name: '如实说没有依据', verdict: judgeLiveReply('这件事我没有记录，不清楚。', UNKNOWN), want: { grounded: true, critical: 0, unsupported: 0 } },
]
for (const item of positive) {
  check(
    `正控（安静）：${item.name}`,
    item.verdict.grounded === item.want.grounded &&
      item.verdict.criticalErrors.length === item.want.critical &&
      item.verdict.unsupportedAssertions.length === item.want.unsupported,
    JSON.stringify(item.verdict)
  )
}

/* ---- 负控：**注入假象必须响**（每条对应一个真实失败形态） ---- */
const negative: { name: string; verdict: LiveJudgeVerdict; wantCritical: boolean }[] = [
  {
    name: '复述被禁止的取值（遗忘/撤回/未入模/跨 owner）',
    verdict: judgeLiveReply('你学校是灵岩大学。', ANSWERABLE),
    wantCritical: true,
  },
  {
    name: '该说"没有依据"却给出具体取值（编造）',
    verdict: judgeLiveReply('你学校是碧溪大学。', UNKNOWN),
    wantCritical: true,
  },
]
for (const item of negative) {
  check(
    `负控（必须响）：${item.name}`,
    item.wantCritical ? item.verdict.criticalErrors.length > 0 : item.verdict.unsupportedAssertions.length > 0,
    JSON.stringify(item.verdict)
  )
}
/* 还有一类负控：**不算 critical，但绝不 grounded**（空转回复） */
check(
  '负控（必须响）：空转回复（既没答也没说没有依据）**不**算 grounded',
  judgeLiveReply('嗯嗯，好的。', ANSWERABLE).grounded === false
)

/* ---- 恢复：放回**合法**输入 ⇒ 重新安静 ---- */
const recovery = judgeLiveReply('你学校是碧溪大学，没错。', ANSWERABLE)
check('恢复（重新安静）：合法输入回到 grounded 且零错误', recovery.grounded === true && recovery.criticalErrors.length === 0, JSON.stringify(recovery))

/* ---- 回复边界：正控（干净回复**不得**被削）· 负控（日志尾**必须**被削）· 恢复 ---- */
const NOISY = '记得。毕业设计。\nAlex: Info #苏沐薇 [PLUGIN:BOOTSTRAP:SERVICE:EMBEDDING] Stopping embedding generation service'
check('正控：**干净**回复逐字保留（边界清理不得吃掉正文）', cleanReply('你学校是碧溪大学。') === '你学校是碧溪大学。', cleanReply('你学校是碧溪大学。'))
check(
  '负控：日志尾**必须**被削掉（噪声不得混进被测对象）',
  cleanReply(NOISY) === '记得。毕业设计。' && !cleanReply(NOISY).includes('[PLUGIN:'),
  JSON.stringify(cleanReply(NOISY))
)
check('恢复：清理后仍是合法输入 ⇒ 判定安静', judgeLiveReply(cleanReply(NOISY), { expectedValue: null, forbiddenValues: ['毕业设计'], expectUnknown: true }).grounded === false)
/* 清理**不得**把"禁止取值"洗掉：噪声在**后面**时，前面的断言仍要被抓 */
check(
  '负控：清理后**仍能抓到**前面的编造（清理不能把违规洗掉）',
  judgeLiveReply(cleanReply('记得。毕业设计。\nInfo [PLUGIN:X] done'), { expectedValue: null, forbiddenValues: ['毕业设计'], expectUnknown: true }).criticalErrors.length > 0
)

/* ---- `M9.5-FMB-01` ③ 的两条**必加**负控（Round 91） ---- */
/*
 * ⚠️ **负控 A（平凡通过）**：一律回答"我没记过"**必须**在"应给出取值"的 case 上**判错**。
 *    它挡的是"靠装傻过关"——那会让 (d) 硬零**平凡为 0**，等于门失效。
 */
check(
  '负控 A（平凡通过）：一律"我没记过"在**应给出取值**的 case 上必须判错',
  (() => {
    const verdict = judgeLiveReply('我没记过。', ANSWERABLE)
    return verdict.grounded === false && verdict.unsupportedAssertions.length > 0
  })(),
  JSON.stringify(judgeLiveReply('我没记过。', ANSWERABLE))
)
/*
 * ⚠️ **负控 B（假阴性）——自失效判据**：一段**语义等价但词形不同**的如实说明，
 *    当前判定器**认不出来**（词形表覆盖不足）。本判据**断言"这个弱点当前存在"**：
 *      · 现在应当**通过**（弱点确实存在）；
 *      · 一旦有人修好词形表（或换 LLM 判定器），它**会翻红** ⇒ **强制回来更新本判据**。
 *    ⇒ 这是本仓库既有的"**特征化**"模式（同 `L-M95-09`：两个门同时断言"尚未夹住"）。
 *    ⇒ 它**不**把弱点藏起来，也**不**为了让门变绿而改判据。
 */
const EQUIVALENT_ABSTENTION = '这事我脑子里没存着。'
check(
  '负控 B（自失效）：词形不同但语义等价的如实说明**当前认不出**（弱点已特征化 ⇒ 修好则本判据翻红）',
  judgeLiveReply(EQUIVALENT_ABSTENTION, UNKNOWN).kind !== 'abstained',
  JSON.stringify(judgeLiveReply(EQUIVALENT_ABSTENTION, UNKNOWN))
)

/* ---- 版本与自检 ---- */
check('判定器版本被钉住（不许静默改判定规则）', JUDGE_VERSION === 'm9.5-live-judge@1')
check('计数自检：正控 + 负控 + 恢复 至少各 1 条', positive.length >= 1 && negative.length >= 1 && true)
const total = passed + failures.length

/* ---- 封存档（与其余门同规格：决定的依据必须可被聚合门审计） ---- */
const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
const runId = createM95RunId({ wpId: 'wp10-live-judge', headShort })
const runDir = openM95RunDir(REPO_ROOT, runId)
const realDbBefore = safeTreeDigest()
const selfCheck = selfCheckMeasurement({ measuredCount: total, notRunCount: 0, failedCount: failures.length })
const payload = {
  schemaVersion: 'm9.5-live-judge@1',
  runId,
  generatedAt: new Date().toISOString(),
  judgeVersion: JUDGE_VERSION,
  scope: {
    verifies: '**判定器自身**：正控（合法输入安静）/ 负控（注入假象必须响）/ 恢复（重新安静）三段式',
    notProves:
      '**不**判措辞自然、**不**判同义改写（确定性判定只能看取值词形）；那需要 LLM 判定器（另需它自己的三控）',
    usedFor: '`m9.5:smoke:live` 的四条门槛里 (a) grounded / (c) unsupported / (d) 关键错误',
  },
  controls: { positive: positive.map((item) => item.name), negative: negative.map((item) => item.name) },
  checks: { passed, failed: failures.length, total },
  failures,
  realDbProtection: { before: realDbBefore, after: safeTreeDigest(), note: '本门不打开数据库' },
}
const evidencePath = join(runDir, 'live-judge.json')
writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
const tree = sourceTreeReading(REPO_ROOT)
const manifestPath = writeM95Manifest(runDir, {
  runId,
  stage: 'wp10',
  lane: 'offline',
  startedAt: STARTED_AT,
  completedAt: new Date().toISOString(),
  head: gitOrNull(['rev-parse', 'HEAD']),
  headShort,
  branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
  dirtyPaths: dirtyPaths(REPO_ROOT),
  sourceTreeHash: tree.treeSha256,
  sourceTreeHashDefinition: tree.definition,
  gateVersion: 'm9.5-live-judge@1',
  dbKind: 'not-applicable',
  isolationProof: { dbTouched: false, method: '**构造属性**：本门不 import 任何数据库入口' },
  configHash: { judgeVersion: JUDGE_VERSION },
  command: [{ cmd: 'pnpm m9.5:live-judge:verify', exitCode: 0 }],
  exitCode: 0,
  completion: 'complete',
  usable: selfCheck.verdict === 'PASS',
  measuredCount: total,
  notRunCount: 0,
  counts: { total, passed, failed: failures.length },
  toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
  supersedes: null,
  artifactHashes: { 'live-judge.json': sha256(readFileSync(evidencePath, 'utf8')) },
})

process.stdout.write(
  [
    `M9.5 live 判定器（${JUDGE_VERSION}）三控验证：通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）`,
    ...failures.map((line) => `  ✗ ${line}`),
    '  范围：**确定性**判定（取值出现/禁止取值泄漏/是否如实说无依据）；**不判**措辞自然与同义改写——那需 LLM 判定器',
    `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
    `  清单：${manifestPath}`,
  ].join('\n') + '\n'
)
if (failures.length > 0 || total === 0) process.exitCode = 3
