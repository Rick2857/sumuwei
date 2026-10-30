/**
 * **P3-5a 真实模型试点的运行守卫**（纯函数 · 零模型请求 · 零出网）。
 *
 * ============================================================================
 *  这一层回答五个问题（与 F2 执行器同一条纪律，**不复制一套新的账本/计量实现**）
 * ============================================================================
 * ```text
 * ① 封存绑定什么：源码指纹、镜像、任务序列、门读数、预算上限、模型参数、
 *    资料快照、协议（+ 任务规格文件本身）—— 少一项 / 变了 ⇒ 漂移（fail-closed）
 * ② 能不能跑：封存在且无漂移 → 预算已批准 → **另一次**运行授权文件在场
 * ③ 请求怎么记账：**发出前**计尝试；usage 缺失 ⇒ 成本不可确认 ⇒ 立即停
 * ④ 崩溃会不会丢题：append-only 请求账本 + 任务账本（`task_started` / `task_finished`）
 * ⑤ 资料快照是不是那份：逐文件 sha256 核对（不符 ⇒ 拒绝，不"大概是同一份"）
 * ```
 *
 * ⚠️ 本模块**不**发请求、**不**连数据库、**不**执行动作、**不**import 任何模型适配器。
 *
 * ============================================================================
 *  复用与新增的边界（**为什么不是"又一套 F2"**）
 * ============================================================================
 * ```text
 * 复用（F2 已导出的通用件，**直接引用，不重写**）：
 *   sha256Text / fileDigestOrMissing
 *   createF2Meter            （计量器：发出前预留、usage 缺失 ⇒ cost_unverifiable）
 *   appendF2AttemptLedger    （请求账本写盘：attempt_started / attempt_finished）
 *   appendF2TaskJournal      （任务账本写盘：task_started / task_finished）
 *   readF2TaskJournal        （任务账本读盘）
 *
 * 新增（P3 自己的封存/守卫类型；**行为与 F2 既有语义一致**）：
 *   封存绑定集合（P3 的 8 项 + 任务规格文件本身）
 *   漂移判定（与 f2SealDrift 同语义：逐项比对 + 摘要 + 绑定条数）
 *   运行授权判定（与 assertF2RunAuthorized 同结构，但**按 P3 的闸门顺序**）
 *   请求账本的**第三种行**（attempt_refused）与它的读法
 * ```
 *
 * ⚠️ **`attempt_refused` 为什么需要自己的读法**：
 *    F2 的 `readF2AttemptLedger` 只认两种行（started / finished），第三种行会让它的
 *    `tokens += entry.charged` 变成 `NaN`。P3 的账本多一行"被计量器拒收、**根本没发出去**"
 *    ⇒ 这里给一个**扩展读法**（F2 逐条语义保持 + 多认一种行），**但计量器仍是 F2 的**。
 */
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// ---------------------------------------------------------------------------
//  复用 F2 的通用件（**不复制**）
// ---------------------------------------------------------------------------
export {
  sha256Text,
  fileDigestOrMissing,
  createF2Meter,
  appendF2AttemptLedger,
  appendF2TaskJournal,
  readF2TaskJournal,
  type F2AttemptLedgerEntry,
  type F2AttemptFinishedEntry,
  type F2AttemptStartedEntry,
  type F2ChargedUsage,
  type F2MeterOptions,
  type F2RequestMeter,
  type F2TaskJournalEntry,
  type F2TaskJournalSummary,
} from './f2-live-runner-guards.ts'
import {
  appendF2AttemptLedger,
  readF2TaskJournal,
  sha256Text,
  type F2AttemptLedgerEntry,
  type F2TaskJournalSummary,
} from './f2-live-runner-guards.ts'

// ---------------------------------------------------------------------------
//  常量与闭集
// ---------------------------------------------------------------------------
export const P3_5_RUNNER_ID = 'p3-5-live-runner@1'
export const P3_5_SEAL_SCHEMA = 'p3-5-sealed-manifest@1'
export const P3_5_SEAL_KIND = 'p3-5-live-model-pilot@1-sealed'
/** 干封存：**没有**真实运行授权（预算与运行授权是**两件事**）。 */
export const P3_5_SEAL_STATUS_NOT_AUTHORIZED = 'SEALED_NOT_AUTHORIZED_TO_RUN'
export const P3_5_SEAL_STATUS_AUTHORIZED = 'SEALED_RUN_AUTHORIZED'

export const P3_5_ARMS = ['A', 'B'] as const
export type P35Arm = (typeof P3_5_ARMS)[number]

/**
 * 冻结材料的 `specDigest`（**唯一事实源**：`task-spec.json#specDigest`）。
 *
 * ⚠️ **这份摘要的原始规范化口径没有随材料发布** ⇒ 运行器**不猜**它是怎么算的：
 *   · 封存/运行时**重算**的是**本仓库自己的**内容摘要（`p35TaskSpecContentDigest`，
 *     口径写在下面，随封存一起落盘）；
 *   · 另外把**材料自己声明的** `specDigest` 与下面这个常量逐字比对
 *     （不符 ⇒ `spec_digest_mismatch` ⇒ 拒绝运行）。
 *   两层合起来 = "材料被换成别的规格"与"材料被改了一个字节"**都**会被拦下。
 *
 * ⚠️ **材料会升版**（Lead 改材料 ⇒ `specDigest` 变）⇒ 这个常量必须与材料同步。
 *    环境变量 `P3_5_EXPECTED_SPEC_DIGEST` 可覆盖它（不用改代码就能钉住另一份材料）。
 */
export const P3_5_EXPECTED_SPEC_DIGEST = '61a2c544eaa987f930aabce5b287f1bbb56baaf7535d2791a6b5488ed305ead5'
export function p35ExpectedSpecDigest(): string {
  return (process.env.P3_5_EXPECTED_SPEC_DIGEST ?? '').trim() || P3_5_EXPECTED_SPEC_DIGEST
}


/**
 * 封存必须绑定的项（闭集）。
 *
 * ⚠️ 前 8 项是任务书点名的；第 9 项 `taskSpec` 是**任务规格文件本身的字节摘要**
 *    （`taskSequence` 绑的是"声明出来的 specDigest"，不是文件内容 ⇒ 单独补这一项
 *    才能把"文件被改了一个字节但 specDigest 字段没动"也拦住）。
 */
export const P3_5_REQUIRED_SEAL_BINDINGS = [
  'sourceFingerprint',
  'image',
  'taskSequence',
  'gateReadings',
  'budgetCaps',
  'modelParameters',
  'corpus',
  'protocol',
  'taskSpec',
  /*
   * ⚠️ 判分口径（evaluation.json）**必须**进封存：否则"跑完之后改判分规则再打分"不会被发现。
   *    （Lead 复核运行器时补的绑定项。）
   */
  'evaluation',
] as const
export type P35SealBindingId = (typeof P3_5_REQUIRED_SEAL_BINDINGS)[number]

/**
 * 门读数（**取不到就 MISSING**，不猜、不把"没读到"当"通过"）。
 *
 * ⚠️ 判分门的 id 由 `P3_5_SCORE_GATE_ID` 覆盖（判分器 `p3-5-score.ts` 由另一条工作流产出，
 *    它的门 id 还没定 ⇒ 给一个可覆盖的缺省值，并在这里**如实标注**这一点）。
 */
export const P3_5_DEFAULT_SCORE_GATE_ID = 'p3:scorer:verify'
export function p35RequiredGateIds(scoreGateId: string = P3_5_DEFAULT_SCORE_GATE_ID): readonly string[] {
  return [
    'p3:skill-usage:verify',
    'p3:skill-revision:verify',
    'p3:skill-rule-dependency:verify',
    'learning:contracts:verify',
    scoreGateId,
  ]
}

/** 守卫的闭集码（**不得**发明新码）。 */
export const P3_5_GUARD_CODES = [
  'missing_seal',
  'seal_drift',
  'seal_incomplete',
  'budget_not_approved',
  'run_not_authorized',
  'endpoint_invalid',
  'db_not_isolated',
  'cost_unverifiable',
  'budget_requests',
  'budget_tokens',
  'turn_request_cap',
  'unconfirmed_cost_events',
  'sequence_timeout',
  'request_timeout',
  'spec_digest_mismatch',
  'corpus_mismatch',
  'ledger_unreadable',
  'journal_unreadable',
  /*
   * ⚠️ 2026-10-29 新增两个码（P3-5b）：**首次请求之前**就要确认"账目/任务账本可追加"。
   *    起因是一次真实故障：`docker cp` 把累计账目写成 `root:root`，容器内运行用户只能读，
   *    第 1 轮发完 4 次真实请求**之后**才在 `appendP35Accounting` 抛 `EACCES` ⇒ 钱花了、账记不上。
   *    这两个码就是那种情况下**零请求退出**用的（闭集仍然闭：只加这两个，语义各指一处写面）。
   */
  'ledger_unwritable',
  'journal_unwritable',
] as const
export type P35GuardCode = (typeof P3_5_GUARD_CODES)[number]

/**
 * F2 计量器的码 → P3 的码（**只改名，不改语义**）。
 *
 * ⚠️ `createF2Meter` 是复用的 F2 实现 ⇒ 它返回的是 F2 的闭集码；
 *    P3 对外报自己的码（`turn_request_cap` 之类）⇒ 这里做一次**一对一**映射。
 */
export function p35GuardCodeOf(f2Code: string): P35GuardCode {
  switch (f2Code) {
    case 'task_request_cap': return 'turn_request_cap'
    case 'budget_requests': return 'budget_requests'
    case 'budget_tokens': return 'budget_tokens'
    case 'cost_unverifiable': return 'cost_unverifiable'
    default: return 'cost_unverifiable'
  }
}


// ---------------------------------------------------------------------------
//  源码指纹（**与 scripts/cognitive/source-fingerprint.ts 同算法**）
// ---------------------------------------------------------------------------
/** 计入指纹的目录（相对仓库根）—— 与 `source-fingerprint.ts` 逐字一致。 */
export const P3_5_FINGERPRINT_DIRS = ['src', 'scripts', 'evals', 'tools', 'serversim'] as const
/** 计入指纹的根文件 —— 与 `source-fingerprint.ts` 逐字一致。 */
export const P3_5_FINGERPRINT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'] as const
/** 永远排除的目录名（任何层级）—— 与 `source-fingerprint.ts` 逐字一致。 */
export const P3_5_FINGERPRINT_EXCLUDED_DIRS = new Set(['node_modules', 'artifacts', 'data', '.git', 'dist', 'coverage'])

function collectFingerprintFiles(dir: string, out: string[]): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries.sort()) {
    const full = join(dir, entry)
    let stats
    try { stats = statSync(full) } catch { continue }
    if (stats.isDirectory()) {
      if (P3_5_FINGERPRINT_EXCLUDED_DIRS.has(entry)) continue
      collectFingerprintFiles(full, out)
      continue
    }
    if (!stats.isFile()) continue
    out.push(full)
  }
}

/**
 * 混合树源码指纹：**路径 + 内容 sha256** 排序后整体 sha256。
 *
 * ⚠️ 与 `scripts/cognitive/source-fingerprint.ts` 是**同一个算法**（那个文件是脚本、
 *    import 进来就会打印并跑 git ⇒ 这里按它的算法逐字重算，而不是 import 它）。
 * ⚠️ 不含 `docs/` `artifacts/` `node_modules/`。
 */
export function computeP35SourceFingerprint(repoRoot: string = process.cwd()): {
  readonly fingerprint: string
  readonly fileCount: number
} {
  const files: string[] = []
  for (const dir of P3_5_FINGERPRINT_DIRS) {
    const full = join(repoRoot, dir)
    if (existsSync(full)) collectFingerprintFiles(full, files)
  }
  for (const file of P3_5_FINGERPRINT_FILES) {
    const full = join(repoRoot, file)
    if (existsSync(full)) files.push(full)
  }
  const entries = files
    .map(full => {
      const rel = relative(repoRoot, full).split('\\').join('/')
      return { path: rel, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const fingerprint = createHash('sha256')
    .update(Buffer.from(entries.map(entry => `${entry.path}\t${entry.sha256}`).join('\n'), 'utf8'))
    .digest('hex')
  return { fingerprint, fileCount: entries.length }
}

// ---------------------------------------------------------------------------
//  冻结材料的读法
// ---------------------------------------------------------------------------
export interface P35TaskSpec {
  readonly taskSpecId: string
  readonly frozenAt: string
  readonly arms: readonly {
    readonly arm: string
    readonly label: string
    readonly catalogMode: boolean
    readonly env: Readonly<Record<string, string>>
    readonly expectedSkillBytes: string
  }[]
  readonly tasks: readonly {
    readonly taskId: string
    readonly kind: string
    readonly text: string
    readonly expect: { readonly files: readonly string[], readonly keywordsAnyOf: readonly string[], readonly minKeywords: number }
  }[]
  readonly repeats: number
  readonly modelParameters: {
    readonly provider: string
    readonly baseUrlHost: string
    readonly model: string
    readonly reasoningEffort: string
    readonly reasoningEffortMustBeInRequest: boolean
    readonly temperature: number
    readonly maxCompletionTokensPerRequest: number
  }
  readonly budgetCaps: {
    readonly requestsPerTurn: number
    readonly turns: number
    readonly requestsCap: number
    readonly tokensCap: number
    readonly perRequestTimeoutSeconds: number
    readonly sequenceTimeoutSeconds: number
    readonly maxUnconfirmedCostEvents: number
    /** ⚠️ `task-spec.json#budgetCaps` **没有**这一项（它在 `modelParameters` 里）；
     *  预算提案的 `caps` 里有 ⇒ 运行时以**预算提案**为准。 */
    readonly maxCompletionTokensPerRequest?: number
  }
  readonly specDigest: string
  readonly [key: string]: unknown
}
export function readP35TaskSpec(path: string): P35TaskSpec | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as P35TaskSpec } catch { return undefined }
}

/** 稳定序列化（键排序）—— 本仓库自带的**内容摘要口径**（写进封存，可复核）。 */
function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stableValue)
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key])
  return out
}

/**
 * 任务规格的**内容摘要**（本仓库口径：去掉 `specDigest` 字段后按键排序序列化再 sha256）。
 *
 * ⚠️ 它**不是**材料里那个 `specDigest`（后者的原始口径没有随材料发布 ⇒ 不猜）。
 */
export function p35TaskSpecContentDigest(spec: unknown): string {
  const source = (spec ?? {}) as Record<string, unknown>
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(source)) if (key !== 'specDigest') rest[key] = source[key]
  return sha256Text(JSON.stringify(stableValue(rest)))
}

/** 材料自声明的 `specDigest` 是否与冻结常量一致（**运行前重算并比对**）。 */
export function verifyP35SpecDigest(spec: P35TaskSpec | undefined): {
  readonly ok: boolean
  readonly declared: string
  readonly expected: string
  readonly contentDigest: string
  readonly wellFormed: boolean
} {
  const expected = p35ExpectedSpecDigest()
  const declared = spec?.specDigest ?? ''
  const contentDigest = spec === undefined ? 'MISSING' : p35TaskSpecContentDigest(spec)
  const wellFormed = /^[0-9a-f]{64}$/.test(declared)
  return { ok: wellFormed && declared === expected && spec !== undefined, declared, expected, contentDigest, wellFormed }
}

export interface P35BudgetProposal {
  readonly budgetProposalId: string
  readonly status: string
  readonly approved: boolean
  readonly approval: {
    readonly approvedBy: string | null
    readonly approvedBasis: string | null
    readonly runAuthorizationRequired: boolean
    readonly note?: string
  }
  readonly caps: {
    readonly requestsPerTurn: number
    readonly requestsCap: number
    readonly tokensCap: number
    readonly maxCompletionTokensPerRequest: number
    readonly perRequestTimeoutSeconds: number
    readonly sequenceTimeoutSeconds: number
    readonly maxUnconfirmedCostEvents: number
    readonly capDerivation?: string
  }
  readonly [key: string]: unknown
}
export function readP35BudgetProposal(path: string): P35BudgetProposal | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as P35BudgetProposal } catch { return undefined }
}

// ---------------------------------------------------------------------------
//  资料快照（逐文件 sha256）
// ---------------------------------------------------------------------------
export interface P35CorpusFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}
export interface P35CorpusManifest {
  readonly corpusId: string
  readonly frozenAt: string
  readonly rootRelativeTo: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly files: readonly P35CorpusFile[]
}
export function readP35CorpusManifest(path: string): P35CorpusManifest | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as P35CorpusManifest } catch { return undefined }
}
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 复制冻结资料到本轮只读根，并**逐文件核对 sha256**（源与副本都核）。
 *
 * ⚠️ 任一文件不符 ⇒ 返回 `corpus_mismatch`（**不**"复制一份大概对的"）。
 */
export function copyP35Corpus(input: {
  readonly manifest: P35CorpusManifest
  readonly sourceRoot: string
  readonly targetRoot: string
}): {
  readonly ok: boolean
  readonly mismatches: readonly string[]
  readonly missing: readonly string[]
  readonly files: readonly { path: string, bytes: number, sha256: string }[]
} {
  const mismatches: string[] = []
  const missing: string[] = []
  const files: { path: string, bytes: number, sha256: string }[] = []
  for (const entry of input.manifest.files) {
    const source = join(input.sourceRoot, entry.path)
    const target = join(input.targetRoot, entry.path)
    if (!existsSync(source)) { missing.push(entry.path); continue }
    const sourceDigest = sha256File(source)
    if (sourceDigest !== entry.sha256) mismatches.push(`${entry.path}（源文件 sha256 与清单不符）`)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    const targetDigest = sha256File(target)
    if (targetDigest !== entry.sha256) mismatches.push(`${entry.path}（副本 sha256 与清单不符）`)
    files.push({ path: entry.path, bytes: statSync(target).size, sha256: targetDigest })
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing, files }
}

/** 核对**已复制**的快照（运行前再核一次：封存之后文件被动过 ⇒ 拒绝）。 */
export function verifyP35Corpus(input: {
  readonly manifest: P35CorpusManifest
  readonly root: string
}): { readonly ok: boolean, readonly mismatches: readonly string[], readonly missing: readonly string[] } {
  const mismatches: string[] = []
  const missing: string[] = []
  for (const entry of input.manifest.files) {
    const target = join(input.root, entry.path)
    if (!existsSync(target)) { missing.push(entry.path); continue }
    if (sha256File(target) !== entry.sha256) mismatches.push(entry.path)
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing }
}

// ---------------------------------------------------------------------------
//  门读数
// ---------------------------------------------------------------------------
export type P35GateReadingStatus = 'PASS' | 'FAIL' | 'MISSING'
export type P35GateReadings = Readonly<Record<string, P35GateReadingStatus | string>>

/** 两种形状都认：扁平 `{id: status}` 与汇总包 `{readings:{id: status}}`。 */
export function unwrapP35GateReadings(parsed: unknown): P35GateReadings {
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as Record<string, unknown>
  const nested = record.readings
  if (typeof nested === 'object' && nested !== null) return nested as P35GateReadings
  return record as P35GateReadings
}

/**
 * 门读数摘要：**缺项记 MISSING**（不抛）。
 *
 * ⚠️ 与 F2 的 `f2GateReadingsDigest` 的差别只有一处，而且是**刻意**的：
 *    F2 缺一项就抛（fail-closed，因为它要求"运行前全部 PASS"）；
 *    P3-5a 的任务书写的是"**取不到就 MISSING**"⇒ 这里如实记 MISSING，
 *    由 `--run` 决定"缺读数 ⇒ 不可运行"。
 */
export function p35GateReadingsDigest(
  readings: P35GateReadings,
  requiredIds: readonly string[] = p35RequiredGateIds(),
): {
  readonly digest: string
  readonly missing: readonly string[]
  readonly failed: readonly string[]
  readonly passed: readonly string[]
} {
  const missing = requiredIds.filter(id => readings[id] === undefined || readings[id] === 'MISSING')
  const failed = requiredIds.filter(id => readings[id] === 'FAIL')
  const passed = requiredIds.filter(id => readings[id] === 'PASS')
  const canonical = requiredIds.map(id => `${id}=${String(readings[id] ?? 'MISSING')}`).join('\n')
  return { digest: sha256Text(canonical), missing, failed, passed }
}

// ---------------------------------------------------------------------------
//  封存
// ---------------------------------------------------------------------------
export interface P35SealBinding {
  readonly id: P35SealBindingId
  readonly value: string
  readonly source: string
}
export function collectP35SealBindings(input: {
  readonly computed: Partial<Record<P35SealBindingId, string>>
  readonly sources?: Partial<Record<P35SealBindingId, string>>
}): P35SealBinding[] {
  return P3_5_REQUIRED_SEAL_BINDINGS.map(id => ({
    id,
    value: input.computed[id] ?? 'MISSING',
    source: input.sources?.[id] ?? 'computed',
  }))
}
export function p35SealDigest(bindings: readonly P35SealBinding[]): string {
  const canonical = [...bindings]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(binding => `${binding.id}=${binding.value}`)
    .join('\n')
  return sha256Text(canonical)
}
/** 封存里值为 `MISSING` 的绑定（**缺一项 ⇒ 不可运行**）。 */
export function p35MissingBindings(bindings: readonly P35SealBinding[]): string[] {
  return bindings.filter(binding => binding.value === 'MISSING').map(binding => binding.id)
}

export interface P35SealedManifest {
  readonly schema: typeof P3_5_SEAL_SCHEMA
  readonly kind: typeof P3_5_SEAL_KIND
  readonly sealedAt: string
  readonly status: string
  readonly startMarker: string
  readonly bindings: readonly P35SealBinding[]
  readonly digest: string
  /** 模型参数**明文**（摘要之外留一份可读副本：必须能看见 `reasoning_effort=low`）。 */
  readonly modelParameters: Readonly<Record<string, unknown>>
  readonly budgetCaps: Readonly<Record<string, unknown>>
  readonly corpus: Readonly<Record<string, unknown>>
  /** 指标口径（`evaluation.json`）的出处与摘要（**出处信息**，不是漂移闸）。 */
  readonly evaluation: { readonly path: string, readonly sha256: string }
  readonly arms: readonly string[]
  readonly tasks: readonly { taskId: string, kind: string }[]
  readonly repeats: number
  readonly note: string
}
export function buildP35SealedManifest(input: {
  readonly bindings: readonly P35SealBinding[]
  readonly sealedAt: string
  readonly authorized?: boolean
  readonly modelParameters: Readonly<Record<string, unknown>>
  readonly budgetCaps: Readonly<Record<string, unknown>>
  readonly corpus: Readonly<Record<string, unknown>>
  readonly evaluation?: { readonly path: string, readonly sha256: string }
  readonly arms: readonly string[]
  readonly tasks: readonly { taskId: string, kind: string }[]
  readonly repeats: number
}): P35SealedManifest {
  const digest = p35SealDigest(input.bindings)
  return {
    schema: P3_5_SEAL_SCHEMA,
    kind: P3_5_SEAL_KIND,
    sealedAt: input.sealedAt,
    status: input.authorized === true ? P3_5_SEAL_STATUS_AUTHORIZED : P3_5_SEAL_STATUS_NOT_AUTHORIZED,
    startMarker: sha256Text(`${input.sealedAt}|${digest}|${P3_5_RUNNER_ID}`).slice(0, 16),
    bindings: input.bindings,
    digest,
    modelParameters: input.modelParameters,
    budgetCaps: input.budgetCaps,
    corpus: input.corpus,
    evaluation: input.evaluation ?? { path: '', sha256: 'MISSING' },
    arms: input.arms,
    tasks: input.tasks,
    repeats: input.repeats,
    note: input.authorized === true
      ? '已授权（本仓库**不**自动创建这种封存）'
      : '干封存：**没有**真实运行授权；`--run` 必须被拒绝',
  }
}
/** 漂移：返回不一致的绑定 id（含 `MISSING` 与数量不符）；空数组 = 一致。 */
export function p35SealDrift(manifest: P35SealedManifest, current: readonly P35SealBinding[]): string[] {
  const problems: string[] = []
  for (const id of P3_5_REQUIRED_SEAL_BINDINGS) {
    const before = manifest.bindings.find(binding => binding.id === id)
    const now = current.find(binding => binding.id === id)
    if (before === undefined || now === undefined || before.value !== now.value) problems.push(id)
  }
  if (manifest.bindings.length !== current.length) problems.push('bindings_count')
  if (p35SealDigest(current) !== manifest.digest) problems.push('digest')
  return problems
}

// ---------------------------------------------------------------------------
//  运行授权（**预算批准 ≠ 运行授权**）
// ---------------------------------------------------------------------------
export interface P35RunAuthorization {
  readonly authorized: true
  readonly authorizedAt: string
  readonly authorizedBy: string
  readonly note?: string
}
/** 读运行授权文件；**内容不合形状 ⇒ 不算授权**（失败关闭）。 */
export function readP35RunAuthorization(path: string): { ok: true, value: P35RunAuthorization } | { ok: false, reason: string } {
  if (!existsSync(path)) return { ok: false, reason: '文件不存在' }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return { ok: false, reason: '不是合法 JSON' } }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: '不是对象' }
  const record = parsed as Record<string, unknown>
  if (record.authorized !== true) return { ok: false, reason: 'authorized !== true' }
  const authorizedAt = typeof record.authorizedAt === 'string' ? record.authorizedAt.trim() : ''
  const authorizedBy = typeof record.authorizedBy === 'string' ? record.authorizedBy.trim() : ''
  if (authorizedAt === '') return { ok: false, reason: '缺 authorizedAt' }
  if (authorizedBy === '') return { ok: false, reason: '缺 authorizedBy' }
  return {
    ok: true,
    value: {
      authorized: true,
      authorizedAt,
      authorizedBy,
      ...(typeof record.note === 'string' ? { note: record.note } : {}),
    },
  }
}

/**
 * 运行授权判定（**闸门顺序**就是任务书写的顺序）。
 *
 * ```text
 * ① 封存在？            ⇒ missing_seal
 * ② 封存无漂移？        ⇒ seal_drift
 * ③ 绑定项齐全？        ⇒ seal_incomplete
 * ④ 预算已批准？        ⇒ budget_not_approved
 * ⑤ 运行授权文件在场？  ⇒ run_not_authorized（预算获批 **不等于** 运行获批）
 * ```
 */
export function assertP35RunAuthorized(input: {
  readonly manifest: P35SealedManifest | undefined
  readonly drift: readonly string[]
  readonly current: readonly P35SealBinding[]
  readonly budgetApproved: boolean
  readonly runAuthorizationRequired: boolean
  readonly authorizationPresent: boolean
}): { readonly ok: true } | { readonly ok: false, readonly code: P35GuardCode, readonly detail: string } {
  if (input.manifest === undefined) return { ok: false, code: 'missing_seal', detail: '没有封存（先跑 --seal）' }
  if (input.drift.length > 0) {
    return { ok: false, code: 'seal_drift', detail: `漂移：${input.drift.join(',')}` }
  }
  const missing = p35MissingBindings(input.current)
  if (missing.length > 0) {
    return { ok: false, code: 'seal_incomplete', detail: `封存绑定缺项：${missing.join(',')}` }
  }
  if (!input.budgetApproved) {
    return { ok: false, code: 'budget_not_approved', detail: 'budget-proposal.json 的 approved 不是 true（预算待用户裁定）' }
  }
  if (input.runAuthorizationRequired && !input.authorizationPresent) {
    return { ok: false, code: 'run_not_authorized', detail: '预算已批准，但**另一次**运行授权文件不在场' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
//  请求账本（F2 的写盘 + **第三种行**）
// ---------------------------------------------------------------------------
/** 被计量器拒收（**根本没发出去**）的一行。 */
export interface P35AttemptRefusedEntry {
  readonly kind: 'attempt_refused'
  readonly taskId: string
  readonly at: number
  readonly code: string
  readonly reason: string
}
export type P35AttemptLedgerEntry = F2AttemptLedgerEntry | P35AttemptRefusedEntry
/** 写盘：**F2 的写盘函数**（追加一行 JSON）。 */
export function appendP35AttemptLedger(path: string, entry: P35AttemptLedgerEntry): void {
  appendF2AttemptLedger(path, entry as unknown as F2AttemptLedgerEntry)
}
export interface P35AttemptLedgerSummary {
  readonly readable: boolean
  readonly entries: readonly P35AttemptLedgerEntry[]
  /** 已**发出**的尝试数（started 计数；被拒的不计）。 */
  readonly requests: number
  /** 已结算的 token（只加 finished；**不**把未结算当 0）。 */
  readonly tokens: number
  /** 未确认成本：finished 里 costConfirmed=false 的个数 + **缺结算**的在途尝试数。 */
  readonly unconfirmed: number
  /** 有 started 但**没有 finished** 的尝试数（崩溃/网络抛错都会留下它）。 */
  readonly inFlight: number
  /** 有界未确认（客户端 abort）事件数。 */
  readonly boundedUnconfirmed: number
  /** 被计量器拒收的次数（**没有物理请求**）。 */
  readonly refused: number
}
/**
 * 读盘（F2 读法 + 多认一种行）。
 *
 * ⚠️ F2 的 `readF2AttemptLedger` 只认两种行；第三种行会让它的 `tokens += entry.charged`
 *    变成 `NaN` ⇒ 这里给一个**扩展读法**（F2 逐条语义保持 + 多认 `attempt_refused`）。
 *    **计量器仍然是 F2 的**（`createF2Meter`），不另起一套。
 */
export function readP35AttemptLedger(path: string): P35AttemptLedgerSummary {
  if (!existsSync(path)) {
    return { readable: false, entries: [], requests: 0, tokens: 0, unconfirmed: 0, inFlight: 0, boundedUnconfirmed: 0, refused: 0 }
  }
  try {
    const entries = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as P35AttemptLedgerEntry)
    const startedByTask = new Map<string, number>()
    const finishedByTask = new Map<string, number>()
    let tokens = 0
    let unconfirmedFinished = 0
    let boundedUnconfirmed = 0
    let refused = 0
    for (const entry of entries) {
      if (entry.kind === 'attempt_refused') { refused += 1; continue }
      if (entry.kind === 'attempt_started') {
        startedByTask.set(entry.taskId, (startedByTask.get(entry.taskId) ?? 0) + 1)
        continue
      }
      finishedByTask.set(entry.taskId, (finishedByTask.get(entry.taskId) ?? 0) + 1)
      tokens += entry.charged
      if (!entry.costConfirmed && entry.bounded === true) boundedUnconfirmed += 1
      else if (!entry.costConfirmed) unconfirmedFinished += 1
    }
    let inFlight = 0
    for (const [taskId, started] of startedByTask) inFlight += Math.max(0, started - (finishedByTask.get(taskId) ?? 0))
    return {
      readable: true, entries,
      requests: [...startedByTask.values()].reduce((sum, count) => sum + count, 0),
      tokens, unconfirmed: unconfirmedFinished + inFlight, inFlight, boundedUnconfirmed, refused,
    }
  } catch {
    return { readable: false, entries: [], requests: 0, tokens: 0, unconfirmed: 0, inFlight: 0, boundedUnconfirmed: 0, refused: 0 }
  }
}

// ---------------------------------------------------------------------------
//  累计账目（**跨封存不清零**：预注册 §4 "不重封存清零账目"）
// ---------------------------------------------------------------------------
export interface P35AccountingEntry {
  readonly at: number
  readonly startMarker: string
  readonly turnId: string
  readonly requests: number
  readonly tokens: number
  readonly unconfirmed: number
  readonly aborted: boolean
}
export function appendP35Accounting(path: string, entry: P35AccountingEntry): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
}
export function readP35Accounting(path: string): {
  readonly readable: boolean
  readonly entries: readonly P35AccountingEntry[]
  readonly requests: number
  readonly tokens: number
  readonly unconfirmed: number
  readonly abortedTurns: number
} {
  if (!existsSync(path)) return { readable: false, entries: [], requests: 0, tokens: 0, unconfirmed: 0, abortedTurns: 0 }
  try {
    const entries = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as P35AccountingEntry)
    return {
      readable: true,
      entries,
      requests: entries.reduce((sum, entry) => sum + entry.requests, 0),
      tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
      unconfirmed: entries.reduce((sum, entry) => sum + entry.unconfirmed, 0),
      abortedTurns: entries.filter(entry => entry.aborted).length,
    }
  } catch {
    return { readable: false, entries: [], requests: 0, tokens: 0, unconfirmed: 0, abortedTurns: 0 }
  }
}

// ---------------------------------------------------------------------------
//  逐轮报告与汇总（**只给原始读数，不下结论**）
// ---------------------------------------------------------------------------
/** 逐轮报告的字段名**照抄判分器接口**（`scripts/cognitive/p3-5-score.ts` 的输入形状）。 */
export interface P35TurnReport {
  readonly turnId: string
  readonly arm: P35Arm
  readonly taskId: string
  readonly repeat: number
  readonly finalText: string
  /** 真实成功读过的路径（**相对资料根**）。 */
  readonly readPaths: readonly string[]
  /** 最终答复里出现的资料路径（**相对资料根**）。 */
  readonly citedPaths: readonly string[]
  readonly skillLoadSucceeded: boolean
  readonly deniedActionCount: number
  readonly outOfBoundaryReadCount: number
  /** 本轮用到的资料快照清单（相对路径）。 */
  readonly snapshotPaths: readonly string[]
  readonly usageMissing?: boolean
  readonly aborted?: boolean
  /** 本轮答复调用失败/被计量器拒收 ⇒ 没有可判的答复正文（**不**假装答过）。 */
  readonly answerMissing?: boolean
  /** 规划旁路诊断（**只读旁路**：每次规划调用的 ok/failure/解析码/步数）。 */
  readonly planDiagnostics?: readonly {
    readonly call: number
    readonly ok: boolean
    readonly failure?: string
    readonly parseFailureCode?: string
    readonly steps?: number
  }[]
  /** 注入上下文的技能 section 指纹（`workflow-skill:<id>@<v>#<指纹>`）。 */
  readonly injectedSkillFingerprints: readonly string[]
  readonly requests?: number
  readonly tokens?: number
  readonly elapsedMs?: number
}
export interface P35ArmTotals {
  readonly arm: P35Arm
  readonly turns: number
  readonly requests: number
  readonly tokens: number
  readonly elapsedMs: number
  readonly skillLoadSucceededTurns: number
  readonly deniedActions: number
  readonly outOfBoundaryReads: number
  readonly abortedTurns: number
  readonly usageMissingTurns: number
  readonly readPaths: readonly string[]
  readonly citedPaths: readonly string[]
  readonly injectedSkillFingerprints: readonly string[]
}
export interface P35ArmDiff {
  readonly taskId: string
  readonly repeat: number
  readonly a: Partial<P35TurnReport>
  readonly b: Partial<P35TurnReport>
  /** 逐字段是否相同（**原始读数差异**，不是结论）。 */
  readonly differingFields: readonly string[]
}
export interface P35Summary {
  readonly schema: 'p3-5-summary@1'
  readonly generatedAt: string
  readonly seal: { readonly digest: string, readonly startMarker: string, readonly sealedAt: string }
  readonly arms: readonly string[]
  readonly turns: readonly P35TurnReport[]
  readonly perArm: readonly P35ArmTotals[]
  readonly armDiff: readonly P35ArmDiff[]
  readonly note: string
}
function uniq(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
export function p35ArmTotals(turns: readonly P35TurnReport[], arm: P35Arm): P35ArmTotals {
  const own = turns.filter(turn => turn.arm === arm)
  return {
    arm,
    turns: own.length,
    requests: own.reduce((sum, turn) => sum + (turn.requests ?? 0), 0),
    tokens: own.reduce((sum, turn) => sum + (turn.tokens ?? 0), 0),
    elapsedMs: own.reduce((sum, turn) => sum + (turn.elapsedMs ?? 0), 0),
    skillLoadSucceededTurns: own.filter(turn => turn.skillLoadSucceeded).length,
    deniedActions: own.reduce((sum, turn) => sum + turn.deniedActionCount, 0),
    outOfBoundaryReads: own.reduce((sum, turn) => sum + turn.outOfBoundaryReadCount, 0),
    abortedTurns: own.filter(turn => turn.aborted === true).length,
    usageMissingTurns: own.filter(turn => turn.usageMissing === true).length,
    readPaths: uniq(own.flatMap(turn => turn.readPaths)),
    citedPaths: uniq(own.flatMap(turn => turn.citedPaths)),
    injectedSkillFingerprints: uniq(own.flatMap(turn => turn.injectedSkillFingerprints)),
  }
}
/** 两臂差异：**只列原始读数的差别**（判"兼容/不兼容"是判分器的职责，不是运行器的）。 */
export function p35ArmDiff(turns: readonly P35TurnReport[]): P35ArmDiff[] {
  const diffs: P35ArmDiff[] = []
  const keys = ['taskId', 'repeat'] as const
  for (const task of uniq(turns.map(turn => turn.taskId))) {
    for (const repeat of uniq(turns.filter(turn => turn.taskId === task).map(turn => String(turn.repeat)))) {
      const repeatNumber = Number(repeat)
      const a = turns.find(turn => turn.arm === 'A' && turn.taskId === task && turn.repeat === repeatNumber)
      const b = turns.find(turn => turn.arm === 'B' && turn.taskId === task && turn.repeat === repeatNumber)
      if (a === undefined && b === undefined) continue
      const differing: string[] = []
      const fields: (keyof P35TurnReport)[] = [
        'skillLoadSucceeded', 'deniedActionCount', 'outOfBoundaryReadCount',
        'readPaths', 'citedPaths', 'injectedSkillFingerprints', 'snapshotPaths',
        'requests', 'tokens', 'elapsedMs', 'usageMissing', 'aborted',
      ]
      for (const field of fields) {
        const left = a === undefined ? undefined : a[field]
        const right = b === undefined ? undefined : b[field]
        if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) differing.push(String(field))
      }
      diffs.push({
        taskId: task,
        repeat: repeatNumber,
        a: a === undefined ? {} : pickTurn(a),
        b: b === undefined ? {} : pickTurn(b),
        differingFields: differing,
      })
    }
  }
  return diffs
}
function pickTurn(turn: P35TurnReport): Partial<P35TurnReport> {
  return {
    turnId: turn.turnId,
    skillLoadSucceeded: turn.skillLoadSucceeded,
    deniedActionCount: turn.deniedActionCount,
    outOfBoundaryReadCount: turn.outOfBoundaryReadCount,
    readPaths: turn.readPaths,
    citedPaths: turn.citedPaths,
    injectedSkillFingerprints: turn.injectedSkillFingerprints,
    snapshotPaths: turn.snapshotPaths,
    requests: turn.requests,
    tokens: turn.tokens,
    elapsedMs: turn.elapsedMs,
    ...(turn.usageMissing === undefined ? {} : { usageMissing: turn.usageMissing }),
    ...(turn.aborted === undefined ? {} : { aborted: turn.aborted }),
  }
}
export function buildP35Summary(input: {
  readonly generatedAt: string
  readonly seal: { readonly digest: string, readonly startMarker: string, readonly sealedAt: string }
  readonly turns: readonly P35TurnReport[]
}): P35Summary {
  return {
    schema: 'p3-5-summary@1',
    generatedAt: input.generatedAt,
    seal: input.seal,
    arms: [...P3_5_ARMS],
    turns: input.turns,
    perArm: P3_5_ARMS.map(arm => p35ArmTotals(input.turns, arm)),
    armDiff: p35ArmDiff(input.turns),
    note: '本文件只给**原始读数**；"兼容 / 不兼容 / 证据不足 / 退化"的结论由判分器负责（预注册 §7）。',
  }
}

/** 任务账本读盘的薄封装（**复用 F2 的读法**）。 */
export function readP35TaskJournal(path: string): F2TaskJournalSummary {
  return readF2TaskJournal(path)
}

// ---------------------------------------------------------------------------
//  P3-5b：三个**零请求可测**的纯函数（runner 用它们；门用假 transport / 假写面验证）
// ---------------------------------------------------------------------------

/**
 * 端点三件（**冻结材料给出的**，不是从仿真容器的 `.env` 里读的）。
 *
 * ⚠️ 为什么不直接用 `process.env`：2026-10-28 首轮试点实测——仿真镜像根目录带仓库 `.env`
 *    （`OPENAI_BASE_URL=http://127.0.0.1:18080/v1`），`src/db/index.ts` 启动时用 dotenv 把
 *    **缺失**变量补进 `process.env` ⇒ 规划器（只读 `process.env`）**打到仿真桩**：
 *    96 次规划请求各 2 token、往返 1–2 ms，只有最终答复（显式用 `endpoint.value`）走真端点。
 *    ⇒ 端点必须**逐字注入**，并且发第一枪之前断言"实际端点 == 冻结端点"。
 */
export interface P35EndpointTriple {
  readonly baseUrl: string
  readonly model: string
  readonly key: string
  readonly host: string
}
export function buildP35PlannerEnv(input: {
  readonly endpoint: P35EndpointTriple
  /** 基线环境（缺省 `process.env`；**显式传入便于门里复现"被污染"的情形**）。 */
  readonly base?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  return {
    ...(input.base ?? process.env),
    OPENAI_API_KEY: input.endpoint.key,
    OPENAI_BASE_URL: input.endpoint.baseUrl,
    OPENAI_SMALL_MODEL: input.endpoint.model,
  }
}

/**
 * 发请求**之前**的端点一致性判定（纯函数）。
 *
 * `plannerEndpointHost` 是规划器自己报出来的实际 host（可能带端口）；`expectedHost` 是冻结端点的 hostname。
 * 不一致 ⇒ `endpoint_invalid`（**拒绝继续烧预算**，不是"只打日志"）。
 */
export function assertP35PlannerEndpoint(input: {
  readonly plannerEndpointHost: string
  readonly expectedHost: string
}): { readonly ok: true } | { readonly ok: false, readonly code: 'endpoint_invalid', readonly detail: string } {
  const actualHostname = input.plannerEndpointHost.split('/')[0]!.split(':')[0]!.trim().toLowerCase()
  const expected = input.expectedHost.trim().toLowerCase()
  if (actualHostname === '' || expected === '') {
    return {
      ok: false,
      code: 'endpoint_invalid',
      detail: `端点 host 读不出（planner=${JSON.stringify(input.plannerEndpointHost)} expected=${JSON.stringify(input.expectedHost)}）`,
    }
  }
  if (actualHostname !== expected) {
    return {
      ok: false,
      code: 'endpoint_invalid',
      detail: `规划器实际端点 ${input.plannerEndpointHost} ≠ 冻结端点 ${input.expectedHost}（可能被仿真镜像的 .env 覆盖）`,
    }
  }
  return { ok: true }
}

/**
 * 这一轮"答复"该怎么收口（纯函数；**不碰模型、不碰 DB**）。
 *
 * 背景（2026-10-28 第二次尝试实测）：答复调用被计量器按 `turn_request_cap` 拒收 ⇒ 正文为空 ⇒
 * 旧代码把空正文交给 `completeTurn` ⇒ 契约层抛 `empty_speech_intent` ⇒ **整个序列崩**。
 * 正确行为：空/被拒 ⇒ **不收口本轮**、如实记 `answerMissing` + `aborted`、**成本和失败轮照记**、序列继续。
 */
export function decideP35TurnAnswer(input: {
  readonly answerText: string
  readonly refusal?: string
  readonly meterStopCode?: string
}): {
  readonly submitReply: boolean
  readonly answerMissing: boolean
  readonly aborted: boolean
  readonly reason?: 'answer_empty' | 'answer_refused' | 'meter_stopped'
} {
  const hasText = input.answerText.trim() !== ''
  const refused = input.refusal !== undefined && input.refusal !== ''
  const stopped = input.meterStopCode !== undefined && input.meterStopCode !== ''
  if (hasText && !refused) {
    return { submitReply: true, answerMissing: false, aborted: stopped }
  }
  return {
    submitReply: false,
    answerMissing: true,
    aborted: true,
    reason: refused ? 'answer_refused' : hasText ? 'meter_stopped' : 'answer_empty',
  }
}

/**
 * 逐轮累计账目行（纯函数；**答复缺失也必须照记成本**）。
 *
 * ⚠️ 抽出来的理由：这是"钱花在哪"的唯一逐轮口子。空答复/被拒/中止的轮次**同样**要进账目——
 *    否则"失败轮"就会变成"没花过钱"的假账。
 */
export function buildP35AccountingEntry(input: {
  readonly at: number
  readonly startMarker: string
  readonly turnId: string
  readonly requests: number
  readonly tokens: number
  readonly unconfirmed: number
  readonly aborted: boolean
}): P35AccountingEntry {
  return {
    at: input.at,
    startMarker: input.startMarker,
    turnId: input.turnId,
    requests: Math.max(0, input.requests),
    tokens: Math.max(0, input.tokens),
    unconfirmed: Math.max(0, input.unconfirmed),
    aborted: input.aborted === true,
  }
}

/**
 * 首次请求**之前**的写面预检：以**实际运行用户**确认三处可追加（纯 fs，零网络、零模型）。
 *
 * 故障原型（实测）：账目文件被 `docker cp` 写坏成 `root:root`，容器内 `aiagent` 只能读 ⇒
 * 第 1 轮**发完 4 次真实请求之后**才在追加时 `EACCES`。⇒ 现在**先探一次**，不可写就零请求退出。
 *
 * 做法：`openSync(path,'a')` + `closeSync`（只打开不写内容；文件不存在则按 append 语义创建空文件，
 * 这正是账本/账本文件应有的初始形态）。父目录不存在时先 `mkdirSync(recursive)`。
 */
export function ensureP35WriteSurfaces(input: {
  readonly accountingPath: string
  readonly ledgerPath: string
  readonly journalPath: string
}): { readonly ok: true } | { readonly ok: false, readonly code: 'ledger_unwritable' | 'journal_unwritable', readonly detail: string } {
  const probe = (path: string, code: 'ledger_unwritable' | 'journal_unwritable'): { ok: true } | { ok: false, code: 'ledger_unwritable' | 'journal_unwritable', detail: string } => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const fd = openSync(path, 'a')
      closeSync(fd)
      return { ok: true }
    } catch (error) {
      const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      return {
        ok: false,
        code,
        detail: `${path} 不可追加：${[errno ?? '', error instanceof Error ? error.message : String(error)].filter(part => part !== '').join(' ')}`,
      }
    }
  }
  /* 账目在**宿主/容器共享**的那一份上（跨封存累计）；本轮账本与任务账本在封存目录里。 */
  const accounting = probe(input.accountingPath, 'ledger_unwritable')
  if (!accounting.ok) return accounting
  const ledger = probe(input.ledgerPath, 'ledger_unwritable')
  if (!ledger.ok) return ledger
  const journal = probe(input.journalPath, 'journal_unwritable')
  if (!journal.ok) return journal
  return { ok: true }
}
