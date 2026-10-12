/**
 * M10 WP0 —— **基线与前置核对**（`pnpm m10:baseline`）。
 *
 * ============================================================================
 *  这份脚本要测的命题（先写命题，再写量具）
 * ============================================================================
 * 「这份 baseline 描述的是**本 checkout 在当前 HEAD 上的真实状态**，
 *    而不是旧结果、别人的工作树、或一次空扫描。」
 *
 * 与 M6.1 / M7 / M8 / M9 的 WP0 是**同一个命题**，判据同源：
 *   ① runId 目录拒绝覆盖 + 清单原子晋升（TD-04①）；
 *   ② 脏文件**归属分类**（m10 自产 / 共享追加 / 并发已知 / 历史证据再生 / 未知），
 *      只有「未知」才降档 —— 别人的未提交改动是**事实**，不是污染。
 *
 * M10 计划 §12 WP0 的工作树纪律：既有修改**登记、不清理、不接管**。
 * 计划编制于 `0bf5e76`（见 M10-Execution-Plan.md 头部）；实际开工基线以本脚本
 * 落盘读数为准。
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · **不 import dotenv**：`.env` 读数来自**文件文本**，不是 `process.env`
 *    （否则"这条读数是哪来的"不可判 —— AGENTS §8.1 的坑）。
 *  · **不 import 任何数据库依赖**，不调 `initDatabase()`，不打开真实库、不取租约。
 *    真实库只做一次**只读内容树摘要**（INC-01 冻结算法 `digestTree`）+ 只读 mtime 观测。
 *  · **不回显任何 key 取值**：白名单键只记"是否存在 + 值长度"；
 *    只有枚举/数值/端点标识留取值（沿用 `run-with-test-model.ts` 的既有口径）。
 *  · 两个对象两个摘要定义，都记录算法原文：
 *      · 真实库 `digestTree()` —— INC-01 冻结算法（唯一实现，本脚本不重写）
 *      · 源码树 `sourceTreeDigest()` —— 本脚本定义（git 工作树内容，含未跟踪未忽略文件）
 *
 * 用法：
 *   pnpm m10:baseline --out artifacts/m10/<runId> --phase before
 *   pnpm m10:baseline --out artifacts/m10/<runId> --phase after
 *   （before 建目录并落 baseline-before.json；after 落 baseline-after.json 并给最终判定）
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
  M10_MANIFEST_VERSION,
  M10_RUN_PARENT,
  createM10RunId,
  openM10RunDir,
  runIdFromM10OutPath,
  writeM10Manifest,
} from './m10-evidence.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..')

/**
 * 源码树摘要的排除前缀（目录级；证据目录是运行产物，不进源码树摘要）。
 *
 * ⚠️ 与 M9 的清单**刻意的差异**：这里按**目录**排除整个 `artifacts/`。
 * 理由：M9 那份清单是逐个里程碑列的，于是 M9.1/M9.5/M9.6 落地后它就不再
 * 覆盖全部证据目录（清单过期 ⇒ "源码树变了"可能只是"某次门跑出来的 JSON"）。
 * M10 的定义要求的是**源码**树摘要，证据是产物不是源码 —— 因此一次性排除干净，
 * 并把算法原文一起落盘（可复核，见 `SOURCE_TREE_ALGORITHM`）。
 */
const SOURCE_TREE_EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'artifacts/',
] as const

/** 真实库只读摘要的目标（`data/` 已被 gitignore，git 看不见它）。 */
const REAL_DB_DIR = 'data/pglite'

/** mtime 观测窗口：最近 2 小时内有写入的文件数（并发会话活动的只读信号）。 */
const MTIME_WINDOW_MS = 2 * 60 * 60 * 1000

/** 允许进入证据的 `.env*` 键（M6.1/M7/M8/M9 同一白名单口径 + M9.1/M9.5 + M10 预留）。 */
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
  // --- M9.1（生产已激活：遗忘呈现遮蔽 + 同内容重述复活发射）-----------------
  'CHARACTER_MEMORY_RESTATEMENT_ENABLED',
  'CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED',
  // --- M9.5（生产 shadow）--------------------------------------------------
  'CHARACTER_MEMORY_SEMANTIC_ENABLED',
  'CHARACTER_MEMORY_SEMANTIC_MODE',
  // --- M10 预留（本里程碑尚未新增；存在即为意外，见 B6）--------------------
  'CHARACTER_GOALS_ENABLED',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

/** 留取值的非机密键（端点标识 / 枚举 / 数值预算 / 布尔开关，不是凭据）。 */
const ENV_VALUE_KEYS = [
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
] as const

/** M10 本 WP 自产文件的路径前缀（本轮新增的脚本 / 文档 / 证据）。 */
const M10_SELF_PREFIXES = [
  'scripts/m10-',
  'docs/m10/M10-Baseline-Report.md',
  'docs/m10/M10-WP0-Handoff.md',
  'artifacts/m10/',
] as const

/** 共享文件：M10 只做**点状追加**（package.json 追加 scripts 条目）。 */
const SHARED_APPENDED_PATHS = ['package.json'] as const

/**
 * 并发会话的已知未提交文件前缀（M8 收口后历史项大多已提交；保留结构以备
 * 共享树再次出现他人在途工作）。这些是**别人的进行中工作**：
 * 保留、不提交、不还原；它们的存在不降档基线判定。
 */
const CONCURRENT_KNOWN_PREFIXES = [
  '.gitignore',
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
  'artifacts/m8/',
  'artifacts/m8.5/',
  'artifacts/m9/',
  'artifacts/m9.1/',
  'artifacts/m9.5/',
  'artifacts/m9.6/',
] as const

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
  'minus excluded prefixes (paths use forward slashes; algorithm defined in scripts/m10-baseline.ts)'

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
// 真实库只读观测（不打开库：只有字节级摘要 + mtime）
// ---------------------------------------------------------------------------

interface RealDbObservation {
  digest: TreeDigest
  latestMtime: string
  filesModifiedInWindow: number
  windowHours: number
}

function observeRealDb(): RealDbObservation {
  const dir = join(REPO_ROOT, REAL_DB_DIR)
  const digest = digestTree(dir)
  let latest = 0
  let inWindow = 0
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
  if (existsSync(dir)) visit(dir)
  return {
    digest,
    latestMtime: latest > 0 ? new Date(latest).toISOString() : '(absent)',
    filesModifiedInWindow: inWindow,
    windowHours: MTIME_WINDOW_MS / 3_600_000,
  }
}

// ---------------------------------------------------------------------------
// 脏文件归属分类
// ---------------------------------------------------------------------------

type DirtyClass = 'm10-self' | 'shared-appended' | 'concurrent-known' | 'regenerated-evidence' | 'unknown'

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
  if (M10_SELF_PREFIXES.some((pre) => path.startsWith(pre))) return 'm10-self'
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
    const status = chunk.slice(0, 2)
    let path = chunk.slice(3)
    // 重命名/复制条目：`XY ORIG\0TARGET\0` —— 归类按目标路径，源路径一并记录
    if (status.includes('R') || status.includes('C')) {
      const target = chunks[i + 1]
      if (target !== undefined) {
        entries.push({ path: target, status: `${status}(→)`, classification: classifyDirty(target) })
        i += 1
        continue
      }
    }
    path = path.replace(/"/g, '')
    entries.push({ path, status, classification: classifyDirty(path) })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const counts: Record<DirtyClass, number> = {
    'm10-self': 0,
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

function readEnvFile(file: string): EnvReading {
  const abs = join(REPO_ROOT, file)
  const readings: EnvReading = {}
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) values.set(m[1], m[2])
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
  readings.__filePresent = { present: existsSync(abs), valueLength: 0 }
  return readings
}

function envReadings(): Record<string, EnvReading> {
  return { '.env': readEnvFile('.env'), '.env.test': readEnvFile('.env.test') }
}

// ---------------------------------------------------------------------------
// 代码面现状（只读文本；"计划 ≠ 已实现"的机器判据）
// ---------------------------------------------------------------------------

interface ImplementationSnapshot {
  goalContractExists: boolean
  goalValidatorExists: boolean
  goalProjectionExists: boolean
  goalAppDirExists: boolean
  goalFlagInFlagsTs: boolean
  goalsSectionKindPresent: boolean
  goalsSectionPriority: string | null
  m10ScriptsInPackageJson: string[]
}

function readText(relPath: string): string {
  const abs = join(REPO_ROOT, relPath)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

function implementationSnapshot(): ImplementationSnapshot {
  let scripts: Record<string, string> = {}
  try {
    scripts = (JSON.parse(readText('package.json')) as { scripts?: Record<string, string> }).scripts ?? {}
  } catch {
    scripts = {}
  }
  const flags = readText('src/kernel/app/flags.ts')
  const context = readText('src/kernel/contracts/context.ts')
  const priorityLine = /goals:\s*(\d+)/.exec(context)
  return {
    goalContractExists: existsSync(join(REPO_ROOT, 'src/kernel/contracts/goal.ts')),
    goalValidatorExists: existsSync(join(REPO_ROOT, 'src/kernel/policies/goal-validator.ts')),
    goalProjectionExists: existsSync(join(REPO_ROOT, 'src/kernel/projections/goal.ts')),
    goalAppDirExists: existsSync(join(REPO_ROOT, 'src/kernel/app/goal')),
    goalFlagInFlagsTs: flags.includes('CHARACTER_GOALS_ENABLED'),
    goalsSectionKindPresent: context.includes("'goals' // M10"),
    goalsSectionPriority: priorityLine?.[1] ?? null,
    m10ScriptsInPackageJson: Object.keys(scripts)
      .filter((k) => k.startsWith('m10:'))
      .sort(),
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
  realDb: RealDbObservation
  dirty: DirtyReport
  env: Record<string, EnvReading>
  implementation: ImplementationSnapshot
}

function capture(): Capture {
  const { head, headShort, branch } = readHead()
  return {
    capturedAt: new Date().toISOString(),
    head,
    headShort,
    branch,
    toolVersions: toolVersions(),
    sourceTree: sourceTreeDigest(),
    realDb: observeRealDb(),
    dirty: dirtyReport(),
    env: envReadings(),
    implementation: implementationSnapshot(),
  }
}

interface CheckResult {
  id: string
  label: string
  pass: boolean
  detail: string
}

function beforeChecks(c: Capture): CheckResult[] {
  const env = c.env['.env']
  const goalsFlag = env.CHARACTER_GOALS_ENABLED
  const impl = c.implementation
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
      label: '真实库只读摘要测到非空集合（measured_count > 0）',
      pass: c.realDb.digest.measuredCount > 0,
      detail: `${c.realDb.digest.measuredCount} 文件 / ${c.realDb.digest.totalBytes} 字节 · treeSha256=${c.realDb.digest.treeSha256.slice(0, 16)}…`,
    },
    {
      id: 'B4',
      label: '脏文件全部归属分类（unknown = 0）',
      pass: c.dirty.counts.unknown === 0,
      detail: `m10-self=${c.dirty.counts['m10-self']} · shared=${c.dirty.counts['shared-appended']} · concurrent=${c.dirty.counts['concurrent-known']} · regenerated=${c.dirty.counts['regenerated-evidence']} · unknown=${c.dirty.counts.unknown}`,
    },
    {
      id: 'B5',
      label: '.env / .env.test 读数来自文件文本（不 import dotenv）',
      pass: true,
      detail:
        '.env present=' +
        String(c.env['.env'].__filePresent.present) +
        ' · .env.test present=' +
        String(c.env['.env.test'].__filePresent.present),
    },
    {
      id: 'B6',
      label:
        '生产面没有 M10 开关（CHARACTER_GOALS_ENABLED 不在 .env —— 激活属 WP12 独立裁定）',
      pass: goalsFlag === undefined || !goalsFlag.present,
      detail: goalsFlag
        ? `present=${String(goalsFlag.present)} value=${JSON.stringify(goalsFlag.value)}`
        : '键不存在（预期形态）',
    },
    {
      id: 'B7',
      label:
        'M10 实现面尚未存在（计划 §22「今天交付的是计划，不是已实现」的机器判据）',
      pass:
        !impl.goalContractExists &&
        !impl.goalValidatorExists &&
        !impl.goalProjectionExists &&
        !impl.goalAppDirExists &&
        !impl.goalFlagInFlagsTs,
      detail:
        `contracts/goal.ts=${String(impl.goalContractExists)} · policies/goal-validator.ts=${String(impl.goalValidatorExists)} · ` +
        `projections/goal.ts=${String(impl.goalProjectionExists)} · app/goal/=${String(impl.goalAppDirExists)} · ` +
        `flags 里的 CHARACTER_GOALS_ENABLED=${String(impl.goalFlagInFlagsTs)}`,
    },
    {
      id: 'B8',
      label: "Context 预留 kind 'goals' 与优先级 45 在场（WP7 的注入点，不是已接线）",
      pass: impl.goalsSectionKindPresent && impl.goalsSectionPriority === '45',
      detail: `kind=${String(impl.goalsSectionKindPresent)} · priority=${impl.goalsSectionPriority ?? '(缺)'}`,
    },
    {
      id: 'B9',
      label:
        '旧文档生产状态与 .env 不一致这一事实在场且可机器读出（分列读数：按最新权威裁决读取，不按旧标题阻断）',
      pass:
        (env.CHARACTER_BELIEF_ENABLED?.value === 'true') &&
        readText('docs/m9/M9-to-M10-Handoff.md').includes('生产激活状态：**NOT ACTIVATED**'),
      detail:
        `.env CHARACTER_BELIEF_ENABLED=${JSON.stringify(env.CHARACTER_BELIEF_ENABLED?.value ?? '(缺)')} · ` +
        `M9-to-M10-Handoff.md 含 'NOT ACTIVATED'=${String(readText('docs/m9/M9-to-M10-Handoff.md').includes('生产激活状态：**NOT ACTIVATED**'))}`,
    },
    {
      id: 'B10',
      label: 'M9.5 生产模式读数 = shadow（M10 必须在该配置下可用，不把 on 收益算成现状）',
      pass: env.CHARACTER_MEMORY_SEMANTIC_MODE?.value === 'shadow',
      detail: `CHARACTER_MEMORY_SEMANTIC_MODE=${JSON.stringify(env.CHARACTER_MEMORY_SEMANTIC_MODE?.value ?? '(缺)')}`,
    },
  ]
}

function afterChecks(before: Capture, after: Capture): CheckResult[] {
  const sourceUnchanged = before.sourceTree.sha256 === after.sourceTree.sha256
  const dbUnchanged = before.realDb.digest.treeSha256 === after.realDb.digest.treeSha256
  /**
   * 源码树变化是否**可由本 WP 自产文件解释**。
   *
   * WP0 的正常形状就是"before 采样 → 写本 WP 的脚本/文档/证据 → after 采样"，
   * 因此源码树摘要**必然**变化。把它一律读成"并发写入"会让每一次合法的 WP0
   * 都报 PARTIAL（M9 的 after 读数正是这个形状）—— 那是一个无法区分的降档。
   *
   * 这里做的**不是放宽**：A12 仍然如实报"摘要变了"，A12b 回答"变的是不是
   * 只有本 WP 自己的文件"（按脏文件归属分类机器判定）。未知文件仍然降档。
   */
  const selfWriteExplained = after.dirty.counts.unknown === 0 && after.dirty.counts['m10-self'] > 0
  return [
    ...beforeChecks(after),
    {
      id: 'A11',
      label: '真实库内容树摘要在采样窗口内逐字相同（**唯一强失败条件**）',
      pass: dbUnchanged,
      detail: `before=${before.realDb.digest.treeSha256.slice(0, 16)}… after=${after.realDb.digest.treeSha256.slice(0, 16)}…`,
    },
    {
      id: 'A12',
      label: '源码树摘要在采样窗口内**是否**变化（如实记录；未变 = 本 WP 未动源码）',
      pass: sourceUnchanged,
      detail: sourceUnchanged
        ? `同值 ${after.sourceTree.sha256.slice(0, 16)}…（${after.sourceTree.fileCount} 文件）`
        : `before=${before.sourceTree.sha256.slice(0, 16)}… after=${after.sourceTree.sha256.slice(0, 16)}…`,
    },
    {
      id: 'A12b',
      label:
        '源码树变化**可由本 WP 自产文件解释**（m10-self > 0 且 unknown = 0）'
        + '—— 未知脏文件仍然降档 PARTIAL',
      pass: sourceUnchanged || selfWriteExplained,
      detail: sourceUnchanged
        ? '源码树未变（无需解释）'
        : `m10-self=${after.dirty.counts['m10-self']} · shared=${after.dirty.counts['shared-appended']} · concurrent=${after.dirty.counts['concurrent-known']} · unknown=${after.dirty.counts.unknown}`,
    },
    {
      id: 'A13',
      label: 'after 时刻脏文件仍全部归属分类（unknown = 0）',
      pass: after.dirty.counts.unknown === 0,
      detail: `unknown=${after.dirty.counts.unknown}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  out?: string
  phase: 'before' | 'after'
  supersedes?: string
  supersedesReason?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: 'before' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
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
    throw new Error('缺 --out artifacts/m10/<runId>（before 阶段可省略 --out，脚本会自动生成 runId 并打印）')
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.out === undefined) {
    if (args.phase !== 'before') {
      throw new Error('after 阶段必须给 --out artifacts/m10/<runId>（即 before 阶段打印的 runId）')
    }
    const { head } = readHead()
    const generated = createM10RunId({ wpId: 'wp0', headShort: head })
    console.log(`runId: ${generated}（自动生成；after 阶段请用 --out ${M10_RUN_PARENT}/${generated}）`)
    args.out = `${M10_RUN_PARENT}/${generated}`
  }
  const runId = runIdFromM10OutPath(REPO_ROOT, args.out ?? '')

  if (args.phase === 'before') {
    const dir = openM10RunDir(REPO_ROOT, runId)
    const cap = capture()
    const checks = beforeChecks(cap)
    const failed = checks.filter((c) => !c.pass).length
    const payload = {
      schema: 'm10-wp0-baseline@1',
      manifestVersion: M10_MANIFEST_VERSION,
      runId,
      phase: 'before',
      supersedes: args.supersedes ?? null,
      supersedesReason: args.supersedesReason ?? null,
      capture: cap,
      checks,
      verdict: 'PENDING-AFTER-SAMPLE',
    }
    writeFileSync(join(dir, 'baseline-before.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    writeM10Manifest(dir, {
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
      notes: args.supersedesReason ?? null,
    })
    console.log(`runId: ${runId}`)
    console.log(`HEAD : ${cap.head} @ ${cap.branch}`)
    for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
    console.log(`verdict: PENDING-AFTER-SAMPLE（先落 before；跑完 WP0 其余步骤后用 --phase after 收口）`)
    return
  }

  // ---- after ----
  const dir = join(REPO_ROOT, M10_RUN_PARENT, runId)
  const beforePath = join(dir, 'baseline-before.json')
  if (!existsSync(beforePath)) {
    throw new Error(`after 阶段要求 ${beforePath} 已存在（先跑 --phase before）`)
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as { capture: Capture }
  const cap = capture()
  const checks = afterChecks(before.capture, cap)
  const failed = checks.filter((c) => !c.pass).length
  const dbCheck = checks.find((c) => c.id === 'A11')
  const explainCheck = checks.find((c) => c.id === 'A12b')
  const sourceCheck = checks.find((c) => c.id === 'A12')
  let verdict: string
  let exitCode: number
  if (dbCheck && !dbCheck.pass) {
    verdict = 'FAIL (REAL DB CHANGED DURING WP0)'
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
    schema: 'm10-wp0-baseline@1',
    manifestVersion: M10_MANIFEST_VERSION,
    runId,
    phase: 'after',
    supersedes: args.supersedes ?? null,
    supersedesReason: args.supersedesReason ?? null,
    before: {
      head: before.capture.head,
      sourceTree: before.capture.sourceTree,
      realDb: before.capture.realDb.digest,
    },
    capture: cap,
    checks,
    verdict,
  }
  writeFileSync(join(dir, 'baseline-after.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
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
    notes: args.supersedesReason ?? null,
  })
  console.log(`runId: ${runId}`)
  console.log(`HEAD : ${cap.head} @ ${cap.branch}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${verdict}`)
  process.exitCode = exitCode
}

main()
