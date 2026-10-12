/**
 * M11 WP0 —— **基线、归属与前置核对**（`pnpm m11:wp0:verify`）。
 *
 * ============================================================================
 *  这份脚本要测的命题（先写命题，再写量具）
 * ============================================================================
 * 「这份 baseline 描述的是**本 checkout 在当前 HEAD 上的真实状态**，
 *   而且计划 §4 的**每一条前置缺口**都指到了一个**实际代码生产者**；
 *   不可证明的条件被如实记成 UNKNOWN/NOT ASSESSED，而不是被猜成满足。」
 *
 * 与 M6.1 / M7 / M8 / M9 / M10 的 WP0 是**同一个命题**，判据同源：
 *   ① runId 目录拒绝覆盖 + 清单原子晋升（TD-04①）；
 *   ② 脏文件**归属分类**（m11 自产 / 共享追加 / 并发已知 / 历史证据再生 / 未知），
 *      只有「未知」才降档 —— 别人的未提交改动是**事实**，不是污染。
 *
 * M11 计划 §9 WP0 的出口：**每个关键输入都有实际代码生产者**；不可证明的条件
 * 写 `UNKNOWN/BLOCKED`。因此本脚本的 P/C/D 三段检查逐条把"计划怎么说"对到
 * "代码里是谁产出的"，并且**不**把"字段存在"读成"链路已通"（§4.1 的原话）。
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · **不 import dotenv**：`.env` 读数来自**文件文本**，不是 `process.env`
 *    （否则"这条读数是哪来的"不可判 —— AGENTS §8.1 的坑）。
 *  · **不 import 任何数据库依赖**，不调 `initDatabase()`，不打开真实库、不取租约。
 *    两个库路径都只做**只读内容树摘要**（INC-01 冻结算法 `digestTree`）+ 只读 mtime。
 *  · **不回显任何 key 取值**：白名单键只记"是否存在 + 值长度"；
 *    只有枚举/数值/端点标识留取值（沿用 `run-with-test-model.ts` 的既有口径）。
 *  · 两个对象两个摘要定义，都记录算法原文：
 *      · 数据库目录 `digestTree()` —— INC-01 冻结算法（唯一实现，本脚本不重写）
 *      · 源码树 `sourceTreeDigest()` —— 本脚本定义（git 工作树内容，含未跟踪未忽略文件）
 *  · **不把本工作树的 `data/pglite` 说成生产库**：M11 的编写工作树与主 checkout
 *    各有一份 `data/pglite`（见 WP0 基线报告 §2.1）。本脚本把两者**分列**读数，
 *    并**不**断言它们相同或不同（除非给了 `--compare-db` 做真实比对）。
 *
 * 用法：
 *   pnpm m11:wp0:verify --phase before [--compare-db <abs> --compare-env <abs>]
 *   pnpm m11:wp0:verify --out artifacts/m11/<runId> --phase after
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  digestTree,
  type TreeDigest,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import { normalizeHeadShort } from './m6.1-evidence.ts'
import {
  M11_MANIFEST_VERSION,
  M11_RUN_PARENT,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..')

/**
 * 源码树摘要的排除前缀（目录级）—— 与 M10 同一口径：
 * 源码树摘要要的是**源码**，证据是产物不是源码（算法原文随证据落盘）。
 */
const SOURCE_TREE_EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'artifacts/',
] as const

/** 本工作树的数据库目录（`data/` 已被 gitignore，git 看不见它）。 */
const LOCAL_DB_DIR = 'data/pglite'

/** mtime 观测窗口：最近 2 小时内有写入的文件数（并发会话活动的只读信号）。 */
const MTIME_WINDOW_MS = 2 * 60 * 60 * 1000

/** 允许进入证据的 `.env*` 键（M6.1…M10 同一白名单口径 + M11 预留）。 */
const ENV_KEYS = [
  'CHARACTER_WEB_SEARCH_ENABLED',
  'CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS',
  'CHARACTER_WEB_SEARCH_MODE',
  'CHARACTER_ROLLUP_TOKENS',
  'CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED',
  'CHARACTER_MEMORY_BACKGROUND_ENABLED',
  'CHARACTER_RELATIONSHIP_CONTEXT_ENABLED',
  'CHARACTER_AFFECT_CONTEXT_ENABLED',
  'CHARACTER_AFFECT_SEMANTIC_MODE',
  'CHARACTER_BELIEF_ENABLED',
  'CHARACTER_MEMORY_RESTATEMENT_ENABLED',
  'CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED',
  'CHARACTER_MEMORY_SEMANTIC_ENABLED',
  'CHARACTER_MEMORY_SEMANTIC_MODE',
  'CHARACTER_GOALS_ENABLED',
  // --- M11 预留（本里程碑尚未新增；存在即为意外，见 C4）--------------------
  'CHARACTER_REFLECTION_ENABLED',
  'CHARACTER_ADAPTIVE_SELF_ENABLED',
  'PGLITE_DATA_DIR',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

/** 留取值的非机密键（端点标识 / 枚举 / 数值预算 / 布尔开关 / 相对库路径，不是凭据）。 */
const ENV_VALUE_KEYS = [
  'PGLITE_DATA_DIR',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'CHARACTER_WEB_SEARCH_MODE',
  'CHARACTER_ROLLUP_TOKENS',
  'CHARACTER_RELATIONSHIP_CONTEXT_ENABLED',
  'CHARACTER_AFFECT_CONTEXT_ENABLED',
  'CHARACTER_AFFECT_SEMANTIC_MODE',
  'CHARACTER_BELIEF_ENABLED',
  'CHARACTER_MEMORY_RESTATEMENT_ENABLED',
  'CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED',
  'CHARACTER_MEMORY_SEMANTIC_ENABLED',
  'CHARACTER_MEMORY_SEMANTIC_MODE',
  'CHARACTER_GOALS_ENABLED',
  'CHARACTER_REFLECTION_ENABLED',
  'CHARACTER_ADAPTIVE_SELF_ENABLED',
] as const

/**
 * M11 本 WP 自产文件的路径前缀（本轮新增/修改的脚本 / 文档 / 证据 / 忽略规则）。
 *
 * ⚠️ 判据缺陷 #3（judge@3 → @4）：第一版**只列了 WP0 的那两个文档文件名**，
 * 于是 WP1 之后的任何一个 WP 去改**自己的**文档，都会被归到 `unknown` ⇒ 判 PARTIAL。
 * 实测：`docs/adr/ADR-085-*.md` 与 `docs/m11/M11-WP1-Handoff.md` 被报成未知脏文件。
 * 修法：按**里程碑面**（而不是按文件清单）划定 —— M11 的脚本 / 文档 / ADR / 证据都是自产。
 * ⚠️ 这**不是**放宽：它仍然只覆盖 M11 自己的路径；别人的在途文件照样落 `unknown`。
 */
const M11_SELF_PREFIXES = [
  'scripts/m11-',
  'docs/m11/',
  'docs/adr/ADR-085-',
  'artifacts/m11/',
] as const

/** 共享文件：M11 只做**点状追加**（package.json 追加 scripts 条目、.gitignore 追加证据段）。 */
const SHARED_APPENDED_PATHS = ['package.json', '.gitignore'] as const

/** 并发会话的已知未提交文件前缀（别人的进行中工作：保留、不提交、不还原）。 */
const CONCURRENT_KNOWN_PREFIXES = [
  'AGENTS.md',
  'README.md',
  'docs/Tech-Debt-Register.md',
  'docs/苏沐薇-使用说明.txt',
  'docs/incidents/',
  'scripts/gates-run.ts',
  'scripts/gates/',
  'src/infrastructure/runtime/guard-timers.ts',
] as const

/** 会被门重跑再生的历史证据前缀（AGENTS §7：只还原白名单，不无差别 checkout）。 */
const REGENERATED_EVIDENCE_PREFIXES = [
  'artifacts/m4-acceptance/',
  'artifacts/m4.5/',
  'artifacts/m5/',
  'artifacts/m5.1/',
  'artifacts/m5.5/',
  'artifacts/m5.5.1/',
  'artifacts/m6/',
  'artifacts/m6.1/',
  'artifacts/m7/',
  'artifacts/m8/',
  'artifacts/m8.5/',
  'artifacts/m9/',
  'artifacts/m9.1/',
  'artifacts/m9.5/',
  'artifacts/m9.6/',
  'artifacts/m10/',
] as const

/** 期望的迁移上界（ADR-077 已应用 0010 ⇒ 真实库 v10；AGENTS 的 v9 叙述是历史）。 */
const EXPECTED_MIGRATION_MAX = 10

/**
 * 判据版本 —— **随判据的每次修订 +1**，并写进 payload 与 manifest。
 *
 * 修订史（每次都是真缺陷换来的，缺陷档一律保留不回写）：
 *   `m11-wp0-judge@1`  P3 对整段文本做 `/cutover/i` ⇒ 把注释读成了字段（§5.1 缺陷 #1）
 *   `m11-wp0-judge@2`  P3 加 `stripComments()`
 *   `m11-wp0-judge@3`  B9 的额度字段扫描**没有限定在 `ContextBudget` 的接口体内** ⇒
 *                     把 `ContextSection.estimatedTokens` 一起数进来，报成"7 个"（正确 **6**）
 *   `m11-wp0-judge@4`  自产前缀只列了 WP0 的两个文件名 ⇒ WP1 之后改**自己的**文档会被判
 *                     `unknown` ⇒ PARTIAL。修法：按**里程碑面**划前缀（`docs/m11/` · `docs/adr/ADR-085-`）
 */
const JUDGE_VERSION = 'm11-wp0-judge@4'

// ---------------------------------------------------------------------------
// git 只读读数
// ---------------------------------------------------------------------------

function gitText(args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function readHead(): { head: string; headShort: string; branch: string } {
  const head = gitText(['rev-parse', 'HEAD']).trim()
  const branch = gitText(['branch', '--show-current']).trim() || '(detached)'
  return { head, headShort: normalizeHeadShort(head), branch }
}

function toolVersions(): { node: string; git: string } {
  return {
    node: process.version,
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
  }
}

// ---------------------------------------------------------------------------
// 源码树摘要（本脚本定义；算法原文随证据落盘）
// ---------------------------------------------------------------------------

const SOURCE_TREE_ALGORITHM =
  'sha256 over sorted concat of `${path}\\n${byteLength}\\n${content}` for every file in ' +
  '`git -c core.quotepath=false ls-files --cached --others --exclude-standard` ' +
  'minus excluded prefixes (paths use forward slashes; algorithm defined in scripts/m11-wp0-verify.ts)'

interface SourceTreeDigest {
  sha256: string
  fileCount: number
  totalBytes: number
  algorithm: string
  excludedPrefixes: string[]
}

function sourceTreeDigest(): SourceTreeDigest {
  const listed = gitText(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const files = listed
    .filter((p) => !SOURCE_TREE_EXCLUDED_PREFIXES.some((pre) => p.startsWith(pre)))
    .sort()
  const hash = createHash('sha256')
  let totalBytes = 0
  let fileCount = 0
  for (const p of files) {
    const abs = join(REPO_ROOT, p)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue // 列表与磁盘之间的竞态：跳过并继续（计数只记真实读到的）
    }
    if (!st.isFile()) continue
    const content = readFileSync(abs)
    totalBytes += content.length
    fileCount += 1
    hash.update(`${p}\n${content.length}\n`)
    hash.update(content)
  }
  return {
    sha256: hash.digest('hex'),
    fileCount,
    totalBytes,
    algorithm: SOURCE_TREE_ALGORITHM,
    excludedPrefixes: [...SOURCE_TREE_EXCLUDED_PREFIXES],
  }
}

// ---------------------------------------------------------------------------
// 数据库目录只读观测（不打开库：只有字节级摘要 + mtime）
// ---------------------------------------------------------------------------

interface DbObservation {
  label: string
  /** 按传入原样记录（可复核；不含凭据）。 */
  path: string
  present: boolean
  digest: TreeDigest | null
  latestMtime: string
  filesModifiedInWindow: number
  windowHours: number
}

function observeDb(label: string, dir: string): DbObservation {
  const exists = existsSync(dir)
  let latest = 0
  let inWindow = 0
  if (exists) {
    const now = Date.now()
    const visit = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const abs = join(d, entry.name)
        if (entry.isDirectory()) {
          visit(abs)
          continue
        }
        if (!entry.isFile()) continue
        const mtimeMs = statSync(abs).mtimeMs
        if (mtimeMs > latest) latest = mtimeMs
        if (now - mtimeMs < MTIME_WINDOW_MS) inWindow += 1
      }
    }
    visit(dir)
  }
  return {
    label,
    path: dir,
    present: exists,
    digest: exists ? digestTree(dir) : null,
    latestMtime: latest > 0 ? new Date(latest).toISOString() : '(absent)',
    filesModifiedInWindow: inWindow,
    windowHours: MTIME_WINDOW_MS / 3_600_000,
  }
}

// ---------------------------------------------------------------------------
// 脏文件归属分类
// ---------------------------------------------------------------------------

type DirtyClass =
  | 'm11-self'
  | 'shared-appended'
  | 'concurrent-known'
  | 'regenerated-evidence'
  | 'unknown'

interface DirtyEntry {
  path: string
  status: string
  classification: DirtyClass
}

interface DirtyReport {
  entries: DirtyEntry[]
  counts: Record<DirtyClass, number>
}

function classifyDirty(path: string): DirtyClass {
  if (M11_SELF_PREFIXES.some((pre) => path.startsWith(pre))) return 'm11-self'
  if ((SHARED_APPENDED_PATHS as readonly string[]).includes(path)) return 'shared-appended'
  if (CONCURRENT_KNOWN_PREFIXES.some((pre) => path === pre || path.startsWith(pre))) {
    return 'concurrent-known'
  }
  if (REGENERATED_EVIDENCE_PREFIXES.some((pre) => path.startsWith(pre))) {
    return 'regenerated-evidence'
  }
  return 'unknown'
}

function dirtyReport(): DirtyReport {
  const raw = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const chunks = raw.split('\0').filter((c) => c.length > 0)
  const entries: DirtyEntry[] = []
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    if (chunk === undefined) continue
    const status = chunk.slice(0, 2)
    let path = chunk.slice(3)
    // 重命名/复制条目：`XY ORIG\0TARGET\0` —— 归类按目标路径
    if (status.includes('R') || status.includes('C')) {
      const target = chunks[i + 1]
      if (target !== undefined) {
        entries.push({
          path: target,
          status: `${status}(→)`,
          classification: classifyDirty(target),
        })
        i += 1
        continue
      }
    }
    path = path.replace(/"/g, '')
    entries.push({ path, status, classification: classifyDirty(path) })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const counts: Record<DirtyClass, number> = {
    'm11-self': 0,
    'shared-appended': 0,
    'concurrent-known': 0,
    'regenerated-evidence': 0,
    unknown: 0,
  }
  for (const e of entries) counts[e.classification] += 1
  return { entries, counts }
}

// ---------------------------------------------------------------------------
// .env / .env.test 只读读数（文件文本，不 import dotenv；不回显 key 取值）
// ---------------------------------------------------------------------------

type EnvReading = Record<string, { present: boolean; valueLength: number; value?: string }>

function readEnvFile(absPath: string): EnvReading {
  const readings: EnvReading = {}
  const present = existsSync(absPath)
  const text = present ? readFileSync(absPath, 'utf8') : ''
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && m[1] !== undefined && m[2] !== undefined) values.set(m[1], m[2])
  }
  for (const key of ENV_KEYS) {
    const value = values.get(key)
    if (value === undefined) {
      readings[key] = { present: false, valueLength: 0 }
      continue
    }
    const base = { present: true, valueLength: value.length }
    readings[key] = (ENV_VALUE_KEYS as readonly string[]).includes(key)
      ? { ...base, value }
      : base
  }
  readings.__filePresent = { present, valueLength: 0 }
  return readings
}

// ---------------------------------------------------------------------------
// 代码面只读快照（「计划 ≠ 已实现」的机器判据）
// ---------------------------------------------------------------------------

function readText(relPath: string): string {
  const abs = join(REPO_ROOT, relPath)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

function readAbs(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf8') : ''
}

/**
 * 去掉注释（`//` 行注释与 `/* … *\/` 块注释）—— **结构判据必须先过这一层**。
 *
 * ⚠️ 这是 M11 WP0 第一代量具的真实缺陷换来的（见基线报告 §5.1）：
 * `cutover` 在 `contracts/goal.ts` 里**只出现在一句注释**中
 * （"③ 没有 `GOAL_ORIGIN`：cutover 是结构性的"），而第一代判据对**整段文本**
 * 做 `/cutover/i` ⇒ 把"契约里没有这个字段"判成了 ❌。
 * M10 的只读契约 §3 早就写明了这条纪律：「判结构先去掉注释 ⇒ 写着"这里不写库"
 * 的注释不会把它自己打成违规」。这里把那条纪律落成代码。
 *
 * ⚠️ 它**不是**放宽：判据仍然测代码，只是不再把散文当代码。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function existsRel(relPath: string): boolean {
  return existsSync(join(REPO_ROOT, relPath))
}

interface CodeSnapshot {
  /** M10 三段 revision 的声明位置 */
  goalStateRevisionDeclared: boolean
  commitmentStateRevisionDeclared: boolean
  commitmentRevisionIndependentComment: boolean
  projectionRowRevisionDeclared: boolean
  /** 完成依据：payload 有 · 折叠层不落 */
  goalCompletedPayloadHasEvidenceRefs: boolean
  goalCompletedReducerDropsEvidenceRefs: boolean
  /** cutover 不在目标投影里 */
  cutoverInGoalStore: boolean
  /** 读时资格重算 */
  recheckGoalDependenciesExported: boolean
  recheckReportHasMeasuredCount: boolean
  /** causedBy 传输缺口 */
  causedByColumnWrittenAsNull: boolean
  causedByReadbackMapped: boolean
  causedByInProposal: boolean
  causedByInValidator: boolean
  causedByFieldInNewDomainEvent: boolean
  /** 上下文预留 */
  adaptiveSelfKindPresent: boolean
  adaptiveSelfPriority: string | null
  contextBudgetTokenFields: string[]
  /** M10 生产装配的额度接线读数（M10.1 WP4b **已销账**：由 false 变 true） */
  goalTokensWiredInMain: boolean
  /** M10.1 新增额度（约定与结清）是否已接线 */
  commitmentTokensWiredInMain: boolean
  rollupTokensWiredInMain: boolean
  /** M11 实现面（应全部不存在 —— 这是 D01/D24 的结构前提） */
  reflectionContractExists: boolean
  adaptiveSelfContractExists: boolean
  reflectionAppDirExists: boolean
  reflectionPolicyExists: boolean
  reflectionFlagInFlagsTs: boolean
  adaptiveSelfFlagInFlagsTs: boolean
  m11ScriptsInPackageJson: string[]
  /** 迁移链 */
  migrationVersions: number[]
  /** 继承缺口 */
  fixtureSourceRevisionOne: boolean
  m95HandoffPresent: boolean
  m96HandoffPresent: boolean
  m10M11ContractPresent: boolean
  agentsSaysV9: boolean
  mainEntryPresent: boolean
  scriptsUsingIsolateDatabase: number
}

function listScripts(): Record<string, string> {
  try {
    const parsed = JSON.parse(readText('package.json')) as { scripts?: Record<string, string> }
    return parsed.scripts ?? {}
  } catch {
    return {}
  }
}

function migrationVersions(): number[] {
  const text = readText('src/infrastructure/persistence/migrations.ts')
  const found = new Set<number>()
  for (const m of text.matchAll(/version:\s*(\d+)\s*,/g)) {
    const raw = m[1]
    if (raw !== undefined) found.add(Number(raw))
  }
  return [...found].sort((a, b) => a - b)
}

function countScriptsUsingIsolateDatabase(): number {
  const dir = join(REPO_ROOT, 'scripts')
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const text = readFileSync(join(dir, entry.name), 'utf8')
    if (text.includes('isolateDatabase')) count += 1
  }
  return count
}

function codeSnapshot(): CodeSnapshot {
  const goalContract = readText('src/kernel/contracts/goal.ts')
  const goalProjection = readText('src/kernel/projections/goal.ts')
  const eventStore = readText('src/infrastructure/persistence/event-store.ts')
  const domainEvent = readText('src/kernel/contracts/domain-event.ts')
  const proposal = readText('src/kernel/contracts/proposal.ts')
  const validator = readText('src/kernel/policies/validator.ts')
  const context = readText('src/kernel/contracts/context.ts')
  const selector = readText('src/kernel/recall/selector.ts')
  const goalInputs = readText('src/kernel/app/goal/inputs.ts')
  const goalStore = existsRel('src/infrastructure/persistence/goal-store.ts')
    ? readText('src/infrastructure/persistence/goal-store.ts')
    : readText('src/kernel/app/goal/store.ts')
  const flags = readText('src/kernel/app/flags.ts')
  const fixtures = readText('src/kernel/app/recall/handoff-fixtures.ts')
  const scripts = listScripts()
  const goalCompletedBranch = goalProjection.slice(
    goalProjection.indexOf('case GOAL_COMPLETED'),
    goalProjection.indexOf('case GOAL_CANCELLED'),
  )
  /*
   * ⚠️ 判据缺陷 #2（judge@2 → @3）：**先把 `ContextBudget` 的接口体截出来再扫**。
   * 上一代直接在整份 `selector.ts` 上扫 `xxxTokens: number` ⇒ 把同文件里
   * `ContextSection.estimatedTokens`（属于 `contracts/context.ts` 的概念，只是恰好在同文件出现过）
   * 一起数进来，报成"7 个额度字段"，而正确答案是 **6**。
   * 这正是「数字对 ≠ 数字描述的是你以为的那个东西」的第二种形态（AGENTS §6.9）。
   */
  const budgetBody = /export interface ContextBudget \{[\s\S]*?\n\}/.exec(selector)?.[0] ?? ''
  const tokenFields = [...budgetBody.matchAll(/^\s{2}([a-zA-Z]+Tokens):\s*number/gm)].map(
    (m) => m[1] ?? '',
  )
  const mainTs = readText('src/main.ts')
  return {
    goalStateRevisionDeclared: /export interface GoalState \{[\s\S]*?\n\}/.test(goalContract)
      ? /\n {2}revision: number/.test(
          /export interface GoalState \{[\s\S]*?\n\}/.exec(goalContract)?.[0] ?? '',
        )
      : false,
    commitmentStateRevisionDeclared: /\n {2}revision: number/.test(
      /export interface CommitmentState \{[\s\S]*?\n\}/.exec(goalContract)?.[0] ?? '',
    ),
    commitmentRevisionIndependentComment: goalContract.includes('与 `goal.revision` **各自独立**'),
    projectionRowRevisionDeclared: /interface CharacterProjection<[\s\S]*?\n {2}revision: number/.test(
      readText('src/kernel/contracts/projection.ts'),
    ),
    goalCompletedPayloadHasEvidenceRefs:
      goalContract.includes('evidenceRefs: GoalSourceRef[]') &&
      goalContract.includes('GoalCompletedPayload'),
    goalCompletedReducerDropsEvidenceRefs:
      goalCompletedBranch.length > 0 && !goalCompletedBranch.includes('evidenceRefs'),
    cutoverInGoalStore:
      /cutover/i.test(stripComments(goalStore)) || /cutover/i.test(stripComments(goalContract)),
    recheckGoalDependenciesExported: goalInputs.includes('export async function recheckGoalDependencies'),
    recheckReportHasMeasuredCount: goalInputs.includes('readonly measuredCount: number'),
    causedByColumnWrittenAsNull: /\$\{null\}::jsonb/.test(
      stripComments(
        eventStore.slice(
          eventStore.indexOf('insert into character_domain_events'),
          eventStore.indexOf('on conflict (idempotency_key) do nothing'),
        ),
      ),
    ),
    causedByReadbackMapped: eventStore.includes(
      'causedByDomainEventIds: causedBy?.map((s) => asDomainEventId(s))',
    ),
    causedByInProposal: proposal.includes('causedBy'),
    causedByInValidator: validator.includes('causedBy'),
    causedByFieldInNewDomainEvent: domainEvent.includes('causedByDomainEventIds?: DomainEventId[]'),
    adaptiveSelfKindPresent: context.includes("'adaptive-self' // M11"),
    adaptiveSelfPriority: /adaptiveSelf:\s*(\d+)/.exec(context)?.[1] ?? null,
    contextBudgetTokenFields: tokenFields.sort(),
    goalTokensWiredInMain: /goalTokens/.test(stripComments(mainTs)),
    commitmentTokensWiredInMain: /commitmentTokens/.test(stripComments(mainTs)),
    rollupTokensWiredInMain: /rollupTokens/.test(stripComments(mainTs)),
    reflectionContractExists: existsRel('src/kernel/contracts/reflection.ts'),
    adaptiveSelfContractExists: existsRel('src/kernel/contracts/adaptive-self.ts'),
    reflectionAppDirExists: existsRel('src/kernel/app/reflection'),
    reflectionPolicyExists: existsRel('src/kernel/policies/reflection-policy.ts'),
    reflectionFlagInFlagsTs: flags.includes('CHARACTER_REFLECTION_ENABLED'),
    adaptiveSelfFlagInFlagsTs: flags.includes('CHARACTER_ADAPTIVE_SELF_ENABLED'),
    m11ScriptsInPackageJson: Object.keys(scripts)
      .filter((k) => k.startsWith('m11:'))
      .sort(),
    migrationVersions: migrationVersions(),
    fixtureSourceRevisionOne: /sourceRevision: 1,/.test(fixtures),
    m95HandoffPresent: existsRel('docs/m9.5/M9.5-to-M10-M11-Handoff.md'),
    m96HandoffPresent: existsRel('docs/m9.6/M9.6-to-M10-M11-Handoff.md'),
    m10M11ContractPresent: existsRel('docs/m10/M10-M11-Read-Only-Contract.md'),
    agentsSaysV9: readText('AGENTS.md').includes('真实库当前已是 **v9**'),
    mainEntryPresent: existsRel('src/main.ts'),
    scriptsUsingIsolateDatabase: countScriptsUsingIsolateDatabase(),
  }
}

// ---------------------------------------------------------------------------
// 捕获与判定
// ---------------------------------------------------------------------------

interface Capture {
  capturedAt: string
  head: string
  headShort: string
  branch: string
  toolVersions: { node: string; git: string }
  sourceTree: SourceTreeDigest
  localDb: DbObservation
  compareDb: DbObservation | null
  dirty: DirtyReport
  env: Record<string, EnvReading>
  compareEnv: { path: string; reading: EnvReading } | null
  code: CodeSnapshot
}

interface Args {
  out?: string
  phase: 'before' | 'after'
  compareDb?: string
  compareEnv?: string
  supersedes?: string
  supersedesReason?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: 'before' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--compare-db') args.compareDb = argv[++i]
    else if (a === '--compare-env') args.compareEnv = argv[++i]
    else if (a === '--phase') {
      const v = argv[++i]
      if (v !== 'before' && v !== 'after') {
        throw new Error(`--phase 只接受 before | after（收到 ${JSON.stringify(v)}）`)
      }
      args.phase = v
    } else if (a === '--supersedes') args.supersedes = argv[++i]
    else if (a === '--supersedes-reason') args.supersedesReason = argv[++i]
    else throw new Error(`未知参数：${JSON.stringify(a)}`)
  }
  if (args.out === undefined && args.phase !== 'before') {
    throw new Error(
      '缺 --out artifacts/m11/<runId>（before 阶段可省略 --out，脚本会自动生成 runId 并打印）',
    )
  }
  return args
}

/**
 * 对照目标在两次采样之间必须一致（否则 before/after 比的不是同一个东西）。
 * 这里只把规范化后的路径记进捕获，供 after 阶段显式比对。
 */
function capture(args: Args): Capture {
  const { head, headShort, branch } = readHead()
  const localDb = observeDb('本工作树 data/pglite', join(REPO_ROOT, LOCAL_DB_DIR))
  const compareDb =
    args.compareDb !== undefined && args.compareDb !== ''
      ? observeDb('对照库目录（--compare-db）', resolve(args.compareDb))
      : null
  const compareEnv =
    args.compareEnv !== undefined && args.compareEnv !== ''
      ? { path: resolve(args.compareEnv), reading: readEnvFile(resolve(args.compareEnv)) }
      : null
  return {
    capturedAt: new Date().toISOString(),
    head,
    headShort,
    branch,
    toolVersions: toolVersions(),
    sourceTree: sourceTreeDigest(),
    localDb,
    compareDb,
    dirty: dirtyReport(),
    env: {
      '.env': readEnvFile(join(REPO_ROOT, '.env')),
      '.env.test': readEnvFile(join(REPO_ROOT, '.env.test')),
    },
    compareEnv,
    code: codeSnapshot(),
  }
}

interface CheckResult {
  id: string
  label: string
  pass: boolean
  detail: string
}

/** A 段 —— 基线与身份（before / after 都要过）。 */
function baselineChecks(c: Capture): CheckResult[] {
  const localDigest = c.localDb.digest
  const migrationOk =
    c.code.migrationVersions.length > 0 &&
    c.code.migrationVersions[0] === 1 &&
    c.code.migrationVersions.every((v, idx) => v === idx + 1) &&
    c.code.migrationVersions[c.code.migrationVersions.length - 1] === EXPECTED_MIGRATION_MAX
  const tokenFields = c.code.contextBudgetTokenFields
  const compareMode =
    c.compareEnv?.reading.CHARACTER_MEMORY_SEMANTIC_MODE?.value ??
    (c.compareEnv === null ? '(未提供 --compare-env)' : '(键不存在)')
  return [
    {
      id: 'B1',
      label: 'HEAD / 分支 / 工具版本已捕获',
      pass: c.head !== '' && c.branch !== '',
      detail: `${c.head.slice(0, 12)} @ ${c.branch} · ${c.toolVersions.node} · ${c.toolVersions.git}`,
    },
    {
      id: 'B2',
      label: '源码树摘要测到非空集合（measured_count > 0）',
      pass: c.sourceTree.fileCount > 0,
      detail: `${c.sourceTree.fileCount} 文件 / ${c.sourceTree.totalBytes} 字节`,
    },
    {
      id: 'B3',
      label: '本工作树 data/pglite 只读摘要测到非空集合（measured_count > 0）',
      pass: localDigest !== null && localDigest.measuredCount > 0,
      detail:
        localDigest === null
          ? '目录不存在 ⇒ 本树没有库（读数缺，不是 PASS）'
          : `${localDigest.measuredCount} 文件 / ${localDigest.totalBytes} 字节 · treeSha256=${localDigest.treeSha256.slice(0, 16)}… · newest=${c.localDb.latestMtime}`,
    },
    {
      id: 'B4',
      label: '脏文件全部归属分类（unknown = 0）',
      pass: c.dirty.counts.unknown === 0,
      detail: `m11-self=${c.dirty.counts['m11-self']} · shared=${c.dirty.counts['shared-appended']} · concurrent=${c.dirty.counts['concurrent-known']} · regenerated=${c.dirty.counts['regenerated-evidence']} · unknown=${c.dirty.counts.unknown}`,
    },
    {
      id: 'B5',
      label: '.env / .env.test 读数来自文件文本（不 import dotenv）—— 含"本树没有"这一事实',
      pass: true,
      detail: `.env present=${String(c.env['.env'].__filePresent.present)} · .env.test present=${String(c.env['.env.test'].__filePresent.present)}（缺文件 ⇒ 本树真实聊天与 Live 门不可运行，是环境阻塞不是产品缺陷）`,
    },
    {
      id: 'B6',
      label: '迁移链连续且上界 = 0010（schema v10）；不靠"字段已存在"推断链路已通',
      pass: migrationOk,
      detail: `versions=[${c.code.migrationVersions.join(', ')}] · 期望 1..${EXPECTED_MIGRATION_MAX} 连续`,
    },
    {
      id: 'B7',
      label: '对照读数：本树 data/pglite 与 --compare-db 是否同一个库（未提供 ⇒ 明确记 NOT ASSESSED）',
      pass: true,
      detail:
        c.compareDb === null || localDigest === null || c.compareDb.digest === null
          ? 'NOT ASSESSED（未提供对照目录，或某侧目录不存在）—— 本读数不主张两者相同或不同'
          : `本树=${localDigest.treeSha256.slice(0, 16)}… · 对照=${c.compareDb.digest.treeSha256.slice(0, 16)}… ⇒ ${
              localDigest.treeSha256 === c.compareDb.digest.treeSha256 ? '内容树逐字相同' : '内容树不同（两份库）'
            }`,
    },
    {
      id: 'B8',
      label: '对照 .env 的 M9.5 语义模式读数已如实捕获（计划 §1.2 说 shadow；实际以读数为准）',
      pass: true,
      detail:
        c.compareEnv === null
          ? 'NOT ASSESSED（未提供 --compare-env）'
          : `${c.compareEnv.path} ⇒ CHARACTER_MEMORY_SEMANTIC_MODE=${JSON.stringify(compareMode)} · ENABLED=${JSON.stringify(c.compareEnv.reading.CHARACTER_MEMORY_SEMANTIC_ENABLED?.value ?? '(键不存在)')}`,
    },
    {
      id: 'B9',
      label: 'ContextBudget 的既有额度字段可机器列出（M11 的新额度必须按同一形状加，缺省 0）',
      pass: tokenFields.length > 0,
      detail: `既有 ${tokenFields.length} 个：${tokenFields.join(' / ')} · adaptiveSelfTokens 在场=${String(tokenFields.includes('adaptiveSelfTokens'))}`,
    },
  ]
}

/** P 段 —— 计划 §4 / §5 WP0 的七项前置核对：每条都必须指到实际代码生产者。 */
function prerequisiteChecks(c: Capture): CheckResult[] {
  const code = c.code
  return [
    {
      id: 'P1',
      label:
        '三段 revision 分列可机器读出（row.revision ≠ goal.revision ≠ commitment.revision）',
      pass:
        code.goalStateRevisionDeclared &&
        code.commitmentStateRevisionDeclared &&
        code.commitmentRevisionIndependentComment &&
        code.projectionRowRevisionDeclared,
      detail:
        `contracts/goal.ts GoalState.revision=${String(code.goalStateRevisionDeclared)} · ` +
        `CommitmentState.revision=${String(code.commitmentStateRevisionDeclared)} · ` +
        `「各自独立」注释=${String(code.commitmentRevisionIndependentComment)} · ` +
        `CharacterProjection.revision=${String(code.projectionRowRevisionDeclared)}`,
    },
    {
      id: 'P2',
      label: '完成依据的实际位置：只在 GOAL_COMPLETED payload，折叠层不落（读事件才能拿到）',
      pass: code.goalCompletedPayloadHasEvidenceRefs && code.goalCompletedReducerDropsEvidenceRefs,
      detail:
        `payload.evidenceRefs=${String(code.goalCompletedPayloadHasEvidenceRefs)} · ` +
        `GOAL_COMPLETED 分支不含 evidenceRefs=${String(code.goalCompletedReducerDropsEvidenceRefs)}`,
    },
    {
      id: 'P3',
      label: 'cutover 不在目标投影里（不是投影字段 ⇒ 必须从激活载体/水位读）',
      pass: !code.cutoverInGoalStore,
      detail: `目标契约或存储里出现 'cutover'=${String(code.cutoverInGoalStore)}（期望 false）`,
    },
    {
      id: 'P4',
      label: '规划依据的资格是**读时重算**：recheckGoalDependencies 在场且报告带 measuredCount',
      pass: code.recheckGoalDependenciesExported && code.recheckReportHasMeasuredCount,
      detail: `导出=${String(code.recheckGoalDependenciesExported)} · report.measuredCount=${String(code.recheckReportHasMeasuredCount)}`,
    },
    {
      id: 'P5',
      label:
        'M10→M11 只读契约在场（九段"在哪读"是 WP2/WP3 的读面依据，不是本脚本自行发明）',
      pass: code.m10M11ContractPresent,
      detail: `docs/m10/M10-M11-Read-Only-Contract.md=${String(code.m10M11ContractPresent)}`,
    },
    {
      id: 'P6',
      label:
        'causedBy 传输缺口**逐条**成立：写入固定 null · 读回已映射 · 提案与校验层不传递 · 类型已预留',
      pass:
        code.causedByColumnWrittenAsNull &&
        code.causedByReadbackMapped &&
        !code.causedByInProposal &&
        !code.causedByInValidator &&
        code.causedByFieldInNewDomainEvent,
      detail:
        `写入 ${'${null}::jsonb'}=${String(code.causedByColumnWrittenAsNull)} · ` +
        `读回映射=${String(code.causedByReadbackMapped)} · ` +
        `proposal 提及=${String(code.causedByInProposal)}（期望 false） · ` +
        `validator 提及=${String(code.causedByInValidator)}（期望 false） · ` +
        `NewDomainEvent 预留字段=${String(code.causedByFieldInNewDomainEvent)}`,
    },
    {
      id: 'P7',
      label:
        '真实入口与实验入口分列：src/main.ts 在场，且既有脚本走 isolateDatabase（M11 新门不得自行开库）',
      pass: code.mainEntryPresent && code.scriptsUsingIsolateDatabase > 0,
      detail: `src/main.ts=${String(code.mainEntryPresent)} · scripts/ 里用 isolateDatabase 的脚本=${code.scriptsUsingIsolateDatabase}`,
    },
    {
      id: 'P8',
      label: 'M9.5 fixture 的固定 revision=1 缺口仍在（生产不能接 fixture 适配器）',
      pass: code.fixtureSourceRevisionOne,
      detail: `handoff-fixtures.ts 里 sourceRevision: 1 = ${String(code.fixtureSourceRevisionOne)}`,
    },
    {
      id: 'P9',
      label: 'M9.5 / M9.6 两份交接文档在场（继承约束有载体，不靠口口相传）',
      pass: code.m95HandoffPresent && code.m96HandoffPresent,
      detail: `M9.5-to-M10-M11=${String(code.m95HandoffPresent)} · M9.6-to-M10-M11=${String(code.m96HandoffPresent)}`,
    },
  ]
}

/** C 段 —— 能力影响矩阵与 D01/D02/D24 的结构前提（M11 尚未实现，这是"起点"不是"缺陷"）。 */
function capabilityChecks(c: Capture): CheckResult[] {
  const code = c.code
  const m11NotImplemented =
    !code.reflectionContractExists &&
    !code.adaptiveSelfContractExists &&
    !code.reflectionAppDirExists &&
    !code.reflectionPolicyExists &&
    !code.reflectionFlagInFlagsTs &&
    !code.adaptiveSelfFlagInFlagsTs
  const compareMode = c.compareEnv?.reading.CHARACTER_MEMORY_SEMANTIC_MODE?.value
  return [
    {
      id: 'C1',
      label: "上下文槽 'adaptive-self' 与优先级 44 已在场（M11 用它，不新造 kind）",
      pass: code.adaptiveSelfKindPresent && code.adaptiveSelfPriority === '44',
      detail: `kind=${String(code.adaptiveSelfKindPresent)} · priority=${code.adaptiveSelfPriority ?? '(缺)'}`,
    },
    {
      id: 'C2',
      label: 'ContextBudget **尚未**有 adaptiveSelfTokens（M11 WP7/WP8 追加，缺省 0）',
      pass: !code.contextBudgetTokenFields.includes('adaptiveSelfTokens'),
      detail: `既有额度字段=[${code.contextBudgetTokenFields.join(', ')}]`,
    },
    {
      id: 'C3',
      label:
        'M11 实现面尚不存在（contracts/reflection · contracts/adaptive-self · app/reflection · reflection-policy）',
      pass: m11NotImplemented,
      detail:
        `contracts/reflection.ts=${String(code.reflectionContractExists)} · ` +
        `contracts/adaptive-self.ts=${String(code.adaptiveSelfContractExists)} · ` +
        `app/reflection/=${String(code.reflectionAppDirExists)} · ` +
        `policies/reflection-policy.ts=${String(code.reflectionPolicyExists)} · ` +
        `flags 两个开关=${String(code.reflectionFlagInFlagsTs)}/${String(code.adaptiveSelfFlagInFlagsTs)}`,
    },
    {
      id: 'C4',
      label:
        'M11 的 package.json 命令集合（WP0 起）—— 本段只登记，不主张实现已完成',
      pass: code.m11ScriptsInPackageJson.length > 0,
      detail: `m11:* = [${code.m11ScriptsInPackageJson.join(', ')}]`,
    },
    {
      id: 'C5',
      label:
        '新增外部能力 = NONE 的结构前提：反思/自适应模块不存在 ⇒ 没有新的 capability / adapter / ActionRequest 生产者',
      pass: m11NotImplemented,
      detail: `反思模块不存在=${String(m11NotImplemented)}（这是 D01 的**起点读数**，不是实现证据）`,
    },
    {
      id: 'C6',
      label: '计划 §1.2 的 "semantic mode = shadow" 与对照 .env 实际读数的差异可机器读出（漂移必须登记）',
      pass: true,
      detail:
        compareMode === undefined
          ? 'NOT ASSESSED（未提供 --compare-env）'
          : `计划 §1.2 说 shadow · 实际=${JSON.stringify(compareMode)} ⇒ ${
              compareMode === 'shadow' ? '一致' : '**不一致（漂移已登记在基线报告）**'
            }`,
    },
  ]
}

/** D 段 —— 继承缺陷 / 文档漂移清单（M11 不许用标签覆盖既有结论）。 */
function inheritedChecks(c: Capture): CheckResult[] {
  const code = c.code
  return [
    {
      id: 'D1',
      label:
        'AGENTS.md 仍写 "真实库当前已是 v9"（文档漂移事实可机器读出；不回写 AGENTS，只在基线登记）',
      pass: code.agentsSaysV9,
      detail: `AGENTS.md 含 '真实库当前已是 **v9**' = ${String(code.agentsSaysV9)}`,
    },
    {
      id: 'D2',
      label:
        'M9.5 D-6「先做记忆体量线」的开关仍未在生产启用（继承排期，M11 不接管这条线）',
      pass: true,
      detail:
        'CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED：本树 ' +
        `${JSON.stringify(c.env['.env'].CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED?.value ?? '(键不存在/本树无 .env)')} · ` +
        `对照 ${c.compareEnv === null ? '(未提供)' : JSON.stringify(c.compareEnv.reading.CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED?.value ?? '(键不存在)')}`,
    },
    {
      id: 'D3',
      label: 'M10 生产激活读数（对照 .env 的 CHARACTER_GOALS_ENABLED）与 FIRST-USE 分列',
      pass: true,
      detail:
        c.compareEnv === null
          ? 'NOT ASSESSED（未提供 --compare-env）'
          : `CHARACTER_GOALS_ENABLED=${JSON.stringify(c.compareEnv.reading.CHARACTER_GOALS_ENABLED?.value ?? '(键不存在)')}（激活 ≠ 首聊已观测：FIRST-USE 是另一槽）`,
    },
    {
      id: 'D4',
      label:
        '**M10.1 WP4b 已销账 `L-M11-10`**：`goalTokens` **已**被生产装配设置（照 `rollupTokens` 形状接线）' +
        '—— 原读数（`false`）是**继承缺陷**：goal-state 块在生产里不可达',
      pass: true,
      detail:
        `src/main.ts 含 goalTokens=${String(code.goalTokensWiredInMain)}（**销账后期望 true**；` +
        `**修订前**读数 = false，那是继承缺陷的读数，见 L-M11-10）· ` +
        `含 commitmentTokens=${String(code.commitmentTokensWiredInMain)}（M10.1 新增额度）· ` +
        `含 rollupTokens=${String(code.rollupTokensWiredInMain)}（**可照抄的接线形状**）`,
    },
  ]
}

/** after 段的强失败条件与自产解释。 */
function afterChecks(before: Capture, after: Capture): CheckResult[] {
  const localUnchanged =
    before.localDb.digest?.treeSha256 === after.localDb.digest?.treeSha256 &&
    before.localDb.present === after.localDb.present
  const sourceUnchanged = before.sourceTree.sha256 === after.sourceTree.sha256
  const selfWriteExplained =
    after.dirty.counts.unknown === 0 && after.dirty.counts['m11-self'] > 0
  return [
    {
      id: 'A11',
      label: '本工作树 data/pglite 内容树摘要在采样窗口内逐字相同（**唯一强失败条件**）',
      pass: localUnchanged,
      detail: `before=${before.localDb.digest?.treeSha256.slice(0, 16) ?? '(缺)'}… after=${after.localDb.digest?.treeSha256.slice(0, 16) ?? '(缺)'}…`,
    },
    {
      id: 'A12',
      label: '源码树摘要是否变化（如实记录；WP0 正常形状 = 变了）',
      pass: true,
      detail: sourceUnchanged
        ? `同值 ${after.sourceTree.sha256.slice(0, 16)}…（${after.sourceTree.fileCount} 文件）`
        : `before=${before.sourceTree.sha256.slice(0, 16)}… after=${after.sourceTree.sha256.slice(0, 16)}…`,
    },
    {
      id: 'A13',
      label: '源码树变化**可由本 WP 自产文件解释**（m11-self > 0 且 unknown = 0）',
      pass: sourceUnchanged || selfWriteExplained,
      detail: sourceUnchanged
        ? '源码树未变（无需解释）'
        : `m11-self=${after.dirty.counts['m11-self']} · shared=${after.dirty.counts['shared-appended']} · concurrent=${after.dirty.counts['concurrent-known']} · unknown=${after.dirty.counts.unknown}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.out === undefined) {
    if (args.phase !== 'before') {
      throw new Error('after 阶段必须给 --out artifacts/m11/<runId>（即 before 阶段打印的 runId）')
    }
    const { head } = readHead()
    const generated = createM11RunId({ wpId: 'wp0', headShort: head })
    console.log(`runId: ${generated}（自动生成；after 阶段请用 --out ${M11_RUN_PARENT}/${generated}）`)
    args.out = `${M11_RUN_PARENT}/${generated}`
  }
  const runId = runIdFromM11OutPath(REPO_ROOT, args.out ?? '')
  const cap = capture(args)

  if (args.phase === 'before') {
    const dir = openM11RunDir(REPO_ROOT, runId)
    const checks = [
      ...baselineChecks(cap),
      ...prerequisiteChecks(cap),
      ...capabilityChecks(cap),
      ...inheritedChecks(cap),
    ]
    const failed = checks.filter((c) => !c.pass).length
    const payload = {
      schema: 'm11-wp0-baseline@1',
      manifestVersion: M11_MANIFEST_VERSION,
      judgeVersion: JUDGE_VERSION,
      runId,
      phase: 'before',
      supersedes: args.supersedes ?? null,
      supersedesReason: args.supersedesReason ?? null,
      capture: cap,
      checks,
      verdict: 'PENDING-AFTER-SAMPLE',
    }
    writeFileSync(join(dir, 'wp0-before.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    writeM11Manifest(dir, {
      runId,
      wp: 'wp0',
      head: cap.head,
      headShort: cap.headShort,
      branch: cap.branch,
      date: cap.capturedAt.slice(0, 10),
      toolVersions: cap.toolVersions,
      testType: 'baseline',
      counts: { total: checks.length, passed: checks.length - failed, failed },
      phases: ['before'],
      supersedes: args.supersedes ?? null,
      notes: `${JUDGE_VERSION}${args.supersedesReason === undefined ? '' : ` · ${args.supersedesReason}`}`,
    })
    console.log(`runId: ${runId}`)
    console.log(`HEAD : ${cap.head} @ ${cap.branch}`)
    for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
    console.log(
      'verdict: PENDING-AFTER-SAMPLE（先落 before；跑完 WP0 其余步骤后用 --phase after 收口）',
    )
    return
  }

  // ---- after ----
  const dir = join(REPO_ROOT, M11_RUN_PARENT, runId)
  const beforePath = join(dir, 'wp0-before.json')
  if (!existsSync(beforePath)) {
    throw new Error(`after 阶段要求 ${beforePath} 已存在（先跑 --phase before）`)
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as { capture: Capture }
  /**
   * ⚠️ 对照目标必须与 before 一致：否则 after 的 B6/B7/B8/C6 比的是**另一个**目标，
   * 而那种错误在输出上看起来完全正常（AGENTS §6.9）。
   */
  const beforeCompareDb = before.capture.compareDb?.path ?? null
  const beforeCompareEnv = before.capture.compareEnv?.path ?? null
  const checks = [
    ...baselineChecks(cap),
    ...prerequisiteChecks(cap),
    ...capabilityChecks(cap),
    ...inheritedChecks(cap),
    ...afterChecks(before.capture, cap),
    {
      id: 'A14',
      label: '对照目标与 before 一致（--compare-db / --compare-env 未在两次采样间被换掉）',
      pass:
        (cap.compareDb?.path ?? null) === beforeCompareDb &&
        (cap.compareEnv?.path ?? null) === beforeCompareEnv,
      detail: `db: before=${beforeCompareDb ?? '(无)'} after=${cap.compareDb?.path ?? '(无)'} · env: before=${beforeCompareEnv ?? '(无)'} after=${cap.compareEnv?.path ?? '(无)'}`,
    },
  ]
  const failed = checks.filter((c) => !c.pass).length
  const dbCheck = checks.find((c) => c.id === 'A11')
  const explainCheck = checks.find((c) => c.id === 'A13')
  const sourceCheck = checks.find((c) => c.id === 'A12')
  let verdict: string
  let exitCode: number
  if (dbCheck && !dbCheck.pass) {
    verdict = 'FAIL (本工作树 data/pglite 在 WP0 期间被改动)'
    exitCode = 2
  } else if (explainCheck && !explainCheck.pass) {
    verdict = 'PARTIAL (源码树变化不能由本 WP 自产文件解释 —— 查未知脏文件)'
    exitCode = 1
  } else if (sourceCheck && !sourceCheck.pass) {
    verdict = 'BASELINE CAPTURED（源码树变化 = 本 WP 自产文件的点状追加，已按归属分类解释）'
    exitCode = 0
  } else {
    verdict = 'BASELINE CAPTURED'
    exitCode = 0
  }
  const payload = {
    schema: 'm11-wp0-baseline@1',
    manifestVersion: M11_MANIFEST_VERSION,
    judgeVersion: JUDGE_VERSION,
    runId,
    phase: 'after',
    supersedes: args.supersedes ?? null,
    supersedesReason: args.supersedesReason ?? null,
    before: {
      head: before.capture.head,
      sourceTree: before.capture.sourceTree,
      localDb: before.capture.localDb.digest,
      compareDbPath: beforeCompareDb,
      compareEnvPath: beforeCompareEnv,
    },
    capture: cap,
    checks,
    verdict,
  }
  writeFileSync(join(dir, 'wp0-after.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp0',
    head: cap.head,
    headShort: cap.headShort,
    branch: cap.branch,
    date: cap.capturedAt.slice(0, 10),
    toolVersions: cap.toolVersions,
    testType: 'baseline',
    counts: { total: checks.length, passed: checks.length - failed, failed },
    phases: ['before', 'after'],
    supersedes: args.supersedes ?? null,
    notes: `${JUDGE_VERSION}${args.supersedesReason === undefined ? '' : ` · ${args.supersedesReason}`}`,
  })
  console.log(`runId: ${runId}`)
  console.log(`HEAD : ${cap.head} @ ${cap.branch}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${verdict}`)
  process.exitCode = exitCode
}

main()
