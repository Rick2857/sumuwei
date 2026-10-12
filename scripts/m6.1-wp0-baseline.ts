/**
 * M6.1 WP0 —— **基线与前置核对**（`pnpm m6.1:wp0:baseline`）。
 *
 * ============================================================================
 *  这份脚本要测的命题（先写命题，再写量具）
 * ============================================================================
 *  「这份 baseline 描述的是**本 checkout 在当前 HEAD 上的真实状态**，
 *    而不是旧结果、别人的工作树、或一次空扫描。」
 *
 *  与 M6 的 WP0（`scripts/m6-wp0-baseline.ts`）是**同一个命题**，但有两处**判据升级**
 *  （对应批准的计划书 §4 WP0 与 TD-04）：
 *
 * ```text
 *   ① runId 目录**拒绝覆盖**（openRunDir）+ 清单**原子晋升**（writeManifestAtomic）
 *      ⇒ 同 HEAD 跑两次不再共用目录，"第二次抹掉第一次"变成机器可见的拒绝
 *   ② 脏文件**归属分类**（m6.1 自产 / 并发共享 / 他人任务 / 未知）
 *      ⇒ "别人的未提交改动"与"未知改动"分开，后者才降档
 * ```
 *
 * ============================================================================
 *  硬边界（这些是判据，不是注释）
 * ============================================================================
 *  · **不 import dotenv**：`.env` 读数来自**文件文本**，不是 `process.env`。
 *    否则"这条读数是哪来的"就不可判（AGENTS §8.1 记录过这个坑）。
 *  · **不 import 任何数据库依赖**，不调 `initDatabase()`，不打开真实库、不取租约。
 *    真实库只做一次**只读内容树摘要**（`data/pglite` 的字节）+ 只读 mtime 观测。
 *  · **不回显任何 key 取值**：白名单键只记"是否存在 + 值长度"。
 *    只有枚举/数值型与端点标识（`CHARACTER_ROLLUP_TOKENS` / `CHARACTER_WEB_SEARCH_MODE` /
 *    `OPENAI_BASE_URL` / `OPENAI_MODEL`）留取值 —— 沿用 `run-with-test-model.ts` 的既有口径。
 *  · 两个**不同对象**用两个**不同定义**的摘要，且都记录算法原文，禁止混用：
 *      · 真实库 `digestTree()`  —— INC-01 的冻结算法（唯一实现，本脚本不重写）
 *      · 源码树 `sourceTreeDigest()` —— 本脚本定义（git 工作树内容，含未跟踪未忽略文件）
 *
 * 用法：
 *   pnpm m6.1:wp0:baseline --out artifacts/m6.1/<runId>
 *   pnpm m6.1:wp0:baseline --out artifacts/m6.1/<runId> --phase after
 *   pnpm m6.1:wp0:baseline --phase before            # 自动生成唯一 runId 并打印
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

import {
  MeasurementInvalidError,
  VOLATILE_EXCLUDED_PATHS,
  digestTree,
  type TreeDigest,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  MANIFEST_FILE,
  M6_1_RUN_ID_PATTERN,
  RunDirExistsError,
  computeManifestPayloadSha256,
  createRunId,
  openRunDir,
  sealManifest,
  writeManifestAtomic,
} from './m6.1-evidence.ts'
import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
} from './m6.1-contract.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 源码树摘要的排除前缀（目录级）。 */
const SOURCE_TREE_EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'artifacts/m6/',
  'artifacts/m6.1/',
  'artifacts/.fast/',
] as const

/** 真实库只读摘要的目标（`data/` 已被 gitignore，git 看不见它）。 */
const REAL_DB_DIR = 'data/pglite'

/**
 * 允许进入证据的 `.env*` 键。
 *
 * ⚠️ 只有**非机密**的三类才留取值：枚举（`CHARACTER_*_MODE`）、数值预算
 * （`CHARACTER_ROLLUP_TOKENS`）、端点标识（`OPENAI_BASE_URL` / `OPENAI_MODEL`）。
 * key 一律只记"是否存在 + 值长度"。
 */
const ENV_KEYS = [
  'CHARACTER_WEB_SEARCH_ENABLED',
  'CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS',
  'CHARACTER_WEB_SEARCH_MODE',
  'CHARACTER_ROLLUP_TOKENS',
  'CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED',
  'CHARACTER_MEMORY_BACKGROUND_ENABLED',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

/** 留取值的非机密键（端点是既有口径；两个 CHARACTER_* 是枚举/数值，不是凭据）。 */
const ENV_VALUE_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'CHARACTER_WEB_SEARCH_MODE',
  'CHARACTER_ROLLUP_TOKENS',
] as const

const ENV_FILES = ['.env', '.env.test', '.env.example', '.env.test.example'] as const

const RECENT_WINDOW_HOURS = 1.5
const LONG_WINDOW_HOURS = 12

// ---------------------------------------------------------------------------
// 归属分类（计划书 §4 WP0 第 1 条：记录文件持有边界）
// ---------------------------------------------------------------------------

/** M6.1 自己建立的产物路径。 */
const M6_1_AUTHORED_PREFIXES = [
  'docs/m6.1/',
  'evals/m6.1/',
  'artifacts/m6.1/',
  'scripts/m6.1-',
  'scripts/kernel-tests-m6.1.ts',
] as const

/**
 * **本次会话同样会点状编辑**的、原本就属于并发会话的文件。
 *
 * 它们被单独列出来不是为了"也算 M6.1 的"，而是为了**不把它们说成未知** ——
 * "共享"与"未知"是两种处置：前者只登记，后者要降档。
 *
 * ⚠️ `.gitattributes` 是 2026-09-23 追加的：M6.1 发现"证据摘要按原始字节算、而
 * `core.autocrlf=true` 会把 `artifacts/**` 签出成 CRLF"⇒ 汇总 PASS 在 clone 之后复现不出来
 * （报告 §21.18）。修法是给 `artifacts/**` 与 `evals/m6.1/**` 两族钉 `eol=lf`
 * —— 那两行只能写在 `.gitattributes` 里。它是**仓库级**文件、与 `.gitignore` 同类，
 * 所以归"共享"而不是"M6.1 自有"：M6.1 只是点了它一次，它不属于任何单一任务。
 */
const SHARED_PATHS = ['package.json', '.gitignore', '.gitattributes'] as const

/** 开工核对时已存在的、**他人任务**的未提交改动（计划书要求不还原、不提交）。 */
const OTHER_TASK_PREFIXES = [
  'scripts/gates/',
  'scripts/gates-run.ts',
  'scripts/verify-gate-runner.ts',
  'scripts/verify-cli-exit-latency.ts',
  'scripts/inc-01-',
  'src/infrastructure/runtime/guard-timers.ts',
  'docs/m6.5/',
  'docs/adr/ADR-051-search-engine-recovery-proposal.md',
  'artifacts/m6/',
  'artifacts/incidents/',
  'docs/incidents/',
  'docs/m6/M6-DSH-Execution-Plan.md',
  /*
   * `docs/m9/` 是**另一个会话**的未跟踪 M9 执行计划（AGENTS §8：不修改、不提交、
   * 不清理他人文件）。它不在任何"自有"清单里 ⇒ 会被记成 `unknown`，于是**即使
   * M8.5 收口提交完自己的产物、工作树干净了**，wp0 基线仍会因它降档 PARTIAL
   * （L-M61-15：剩余 unknown 从"M8 在途"换成"他人任务在途"）。
   *
   * 这里只做**如实归属**：它是他人任务的产物，本来就是 `other-task`。
   * ⚠️ 这不是"把它当绿"——它仍是一条真实存在的未跟踪在途文件（R-01 同型风险），
   * 由它的作者提交或明确交接，不在本量具的处置范围内。
   */
  'docs/m9/',
  'AGENTS.md',
  'README.md',
  'docs/苏沐薇-使用说明.txt',
  /*
   * ⚠️ 这条是**兜底**，必须放在 `M6_1_AUTHORED_PREFIXES` **之后**判定
   * （`classifyOwnership` 的顺序就是判据）：
   *
   *   `artifacts/` 下**除 `artifacts/m6.1/` 以外**的一切，都是别的里程碑/别的会话的
   *   证据面。它们会被那一边的门重跑重新生成（AGENTS §7 明令不要顺手提交这些
   *   被重新生成的历史证据）。M6.1 对它们**只登记**。
   *
   * 这条兜底是**实测**逼出来的：第一版漏了 `artifacts/m5*` 与 `scripts/inc-01-regression.ts`，
   * 于是 8 条真实的并发改动被记成 `unknown`，verdict 会被降成 PARTIAL。
   * 那一轮（`…-2765`）**保留在磁盘上**并在 manifest 的 `supersedes` 里具名，
   * 不当成没发生过。
   */
  'artifacts/',
] as const

type Ownership =
  | 'm6.1-wp0'
  | 'shared-m6.1-and-other-task'
  | 'other-task'
  | 'unknown'

function classifyOwnership(path: string): Ownership {
  if (M6_1_AUTHORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'm6.1-wp0'
  if ((SHARED_PATHS as readonly string[]).includes(path)) return 'shared-m6.1-and-other-task'
  if (OTHER_TASK_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'other-task'
  return 'unknown'
}

/** 源码树差异里"已被解释"的归属（只有 `unexpected` 会让 verdict 降档）。 */
function isExplainedInTreeDiff(path: string): boolean {
  return classifyOwnership(path) !== 'unknown'
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

interface CommandReading {
  cmd: string
  exitCode: number
  note?: string
}

const commands: CommandReading[] = []

function git(args: string[], note?: string): string {
  const cmd = `git ${args.join(' ')}`
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    commands.push({ cmd, exitCode: 0, ...(note !== undefined ? { note } : {}) })
    return out
  } catch (error) {
    commands.push({ cmd, exitCode: 1, ...(note !== undefined ? { note } : {}) })
    throw error
  }
}

/** NUL 分隔版本：非 ASCII 路径不会被 `core.quotepath` 转义成一个带引号的假路径。 */
function gitZ(args: string[], note?: string): string[] {
  return git([...args, '-z'], note).split('\0').filter((entry) => entry !== '')
}

function sha256OfFile(abs: string): string {
  if (!existsSync(abs)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：证据文件不存在 ${abs}`)
  }
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

function safeHash(abs: string): string | null {
  return existsSync(abs) ? sha256OfFile(abs) : null
}

function safeVersion(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/**
 * 这份运行的 `evidence[]`。
 *
 * **重建而不是追加**：before 与 after 两阶段都调它，于是"哪些文件属于这次运行"
 * 只有一个答案。追加式（after 时把新条目 push 上去）会随执行次数漂移。
 *
 * 同时把**别的固定路径门的证据**（L1 部件门的 `artifacts/m6.1/component.json`）
 * 也挂进来 —— 这是 `m6.1:gates` 能"只读显式清单引用"的前提：汇总不扫目录，
 * 它只读清单里列出的文件。
 */
function collectEvidence(root: string, runDir: string): { path: string; sha256: string }[] {
  const candidates = [
    join(runDir, 'baseline.json'),
    join(runDir, 'source-tree-index.before.txt'),
    join(runDir, 'source-tree-index.after.txt'),
    join(runDir, 'source-tree-index.verify.txt'),
    // 固定路径的离线门证据。⚠️ 两者的**时钟性质不同**（实测 2026-09-27）：
    //    · `component.json` 无时钟字段 ⇒ 重复运行逐字节相同（不会弄脏工作树）；
    //    · `measurement.json` **有** `startedAt` / `finishedAt` ⇒ 每次 `m6.1:measurement:verify`
    //      都会改写一份**已入库**的文件（只差那两行；证据提交纪律见 AGENTS §7）。
    // ⚠️ 顺序纪律：**先跑这些门，再跑本次运行** —— 否则清单会指向一份即将被改写的证据，
    //    而那会以 `evidence_hash_mismatch` 的形式显式暴露（不是静默的旧绿）。
    join(root, 'artifacts', 'm6.1', 'component.json'),
    join(root, 'artifacts', 'm6.1', 'measurement.json'),
  ]
  const out: { path: string; sha256: string }[] = []
  for (const abs of candidates) {
    if (!existsSync(abs)) continue
    out.push({
      path: relative(root, abs).split(/[\\/]/).join('/'),
      sha256: sha256OfFile(abs),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 源码树摘要（本脚本定义；与真实库的 digestTree 是两个不同对象）
// ---------------------------------------------------------------------------

interface SourceTreeShape {
  definition: string
  measuredCount: number
  totalBytes: number
  treeSha256: string
  excludedPrefixes: string[]
  indexFile: string
  indexSha256: string
}

interface SourceTreeDigest extends SourceTreeShape {
  lines: string[]
  perFile: Map<string, { size: number; sha256: string }>
}

function sourceTreeDigest(root: string, indexFile: string): SourceTreeDigest {
  const tracked = gitZ(['ls-files'], '已跟踪文件清单（NUL 分隔，避免 core.quotepath 改写中文路径）')
  const untracked = gitZ(
    ['ls-files', '--others', '--exclude-standard'],
    '未跟踪但未被忽略的文件'
  )
  const all = [...new Set([...tracked, ...untracked])].sort()

  const perFile = new Map<string, { size: number; sha256: string }>()
  let totalBytes = 0
  for (const rel of all) {
    if (SOURCE_TREE_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：git 报出但磁盘不存在 ${rel}`)
    }
    const content = readFileSync(abs)
    perFile.set(rel, { size: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    totalBytes += content.length
  }
  if (perFile.size === 0) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：源码树未测到任何文件（measured_count = 0）'
    )
  }

  const lines = [...perFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, info]) => `${rel}\t${info.size}\t${info.sha256}\n`)

  return {
    definition:
      '源码树摘要（M6.1 WP0 定义，与真实库 digestTree 不同对象）：' +
      '文件集 = git ls-files ∪ git ls-files --others --exclude-standard，' +
      `排除前缀 ${SOURCE_TREE_EXCLUDED_PREFIXES.join(' / ')}；` +
      '按相对路径 ordinal 升序 → 每行 `${rel}\\t${size}\\t${sha256(内容)}\\n` → 整段 UTF-8 求 sha256。',
    measuredCount: perFile.size,
    totalBytes,
    treeSha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'),
    excludedPrefixes: [...SOURCE_TREE_EXCLUDED_PREFIXES],
    indexFile,
    indexSha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'),
    lines,
    perFile,
  }
}

function shapeOf(digest: SourceTreeDigest): SourceTreeShape {
  return {
    definition: digest.definition,
    measuredCount: digest.measuredCount,
    totalBytes: digest.totalBytes,
    treeSha256: digest.treeSha256,
    excludedPrefixes: digest.excludedPrefixes,
    indexFile: digest.indexFile,
    indexSha256: digest.indexSha256,
  }
}

function parseSourceTreeIndex(text: string): Map<string, { size: number; sha256: string }> {
  const map = new Map<string, { size: number; sha256: string }>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length !== 3) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：源码树索引行格式坏了（期望 3 段，收到 ${parts.length}）：${line.slice(0, 80)}`
      )
    }
    const [rel, size, sha256] = parts as [string, string, string]
    map.set(rel, { size: Number(size), sha256 })
  }
  if (map.size === 0) {
    // AGENTS §6.8 记录过的真实事故形态：清单格式坏掉 ⇒ 解析出 0 条 ⇒ 看起来"全部一致"
    throw new MeasurementInvalidError('MEASUREMENT INVALID：源码树索引解析出 0 条记录')
  }
  return map
}

interface TreeDiffEntry {
  path: string
  kind: 'added' | 'removed' | 'changed'
  ownership: Ownership
  classification: 'explained' | 'unexpected'
}

function diffSourceTree(
  before: Map<string, { size: number; sha256: string }>,
  after: Map<string, { size: number; sha256: string }>
): { changedFiles: TreeDiffEntry[]; unexpected: number } {
  const changedFiles: TreeDiffEntry[] = []
  const paths = new Set([...before.keys(), ...after.keys()])
  for (const path of [...paths].sort()) {
    const a = before.get(path)
    const b = after.get(path)
    let kind: TreeDiffEntry['kind'] | undefined
    if (a === undefined) kind = 'added'
    else if (b === undefined) kind = 'removed'
    else if (a.sha256 !== b.sha256 || a.size !== b.size) kind = 'changed'
    if (kind === undefined) continue
    changedFiles.push({
      path,
      kind,
      ownership: classifyOwnership(path),
      classification: isExplainedInTreeDiff(path) ? 'explained' : 'unexpected',
    })
  }
  return {
    changedFiles,
    unexpected: changedFiles.filter((entry) => entry.classification === 'unexpected').length,
  }
}

// ---------------------------------------------------------------------------
// 真实库只读观测
// ---------------------------------------------------------------------------

const REAL_DB_DEFINITION =
  '真实库内容树摘要（INC-01 冻结算法，唯一实现 `digestTree()`）：相对路径 ordinal 升序 → ' +
  '每行 `${rel}\\t${size}\\t${sha256(内容)}\\n` → 整段 UTF-8 求 sha256；默认排除 postmaster.pid；' +
  'measuredCount = 0 ⇒ 抛 MeasurementInvalidError。'

function readRealDbMtimes(root: string): {
  newestMtime: string | null
  oldestMtime: string | null
  newestFiles: { path: string; mtime: string }[]
  filesNewerThanShortWindow: number
  filesNewerThanLongWindow: number
  volatileExcluded: string[]
} {
  const base = join(root, REAL_DB_DIR)
  if (!existsSync(base)) {
    return {
      newestMtime: null,
      oldestMtime: null,
      newestFiles: [],
      filesNewerThanShortWindow: 0,
      filesNewerThanLongWindow: 0,
      volatileExcluded: [],
    }
  }
  const entries: { rel: string; mtimeMs: number; mtime: string }[] = []
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        walk(abs)
        continue
      }
      if (!dirent.isFile()) continue
      const stat = statSync(abs)
      entries.push({
        rel: relative(base, abs).split(/[\\/]/).join('/'),
        mtimeMs: stat.mtimeMs,
        mtime: stat.mtime.toISOString(),
      })
    }
  }
  walk(base)
  const volatile = entries.filter((entry) => VOLATILE_EXCLUDED_PATHS.includes(entry.rel))
  const stable = entries.filter((entry) => !VOLATILE_EXCLUDED_PATHS.includes(entry.rel))
  const sorted = [...stable].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const shortCutoff = Date.now() - RECENT_WINDOW_HOURS * 3600 * 1000
  const longCutoff = Date.now() - LONG_WINDOW_HOURS * 3600 * 1000
  return {
    newestMtime: sorted[0]?.mtime ?? null,
    oldestMtime: sorted[sorted.length - 1]?.mtime ?? null,
    newestFiles: sorted.slice(0, 5).map((entry) => ({ path: entry.rel, mtime: entry.mtime })),
    filesNewerThanShortWindow: stable.filter((entry) => entry.mtimeMs >= shortCutoff).length,
    filesNewerThanLongWindow: stable.filter((entry) => entry.mtimeMs >= longCutoff).length,
    volatileExcluded: volatile.map((entry) => `${entry.rel}（易失运行态，摘要已排除）`),
  }
}

// ---------------------------------------------------------------------------
// 配置只读核对（白名单；机密键永不回显取值）
// ---------------------------------------------------------------------------

interface EnvFileReading {
  path: string
  present: boolean
  bytes: number | null
  mtime: string | null
  sha256: string | null
}

interface EnvKeyReading {
  key: string
  presentIn: string[]
  valueLengthByFile: Record<string, number>
  nonSecretValueByFile?: Record<string, string>
}

function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    map.set(key, value)
  }
  return map
}

function readEnvConfig(root: string): {
  files: EnvFileReading[]
  keys: EnvKeyReading[]
  note: string
} {
  const files: EnvFileReading[] = []
  const parsed = new Map<string, Map<string, string>>()
  for (const rel of ENV_FILES) {
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      files.push({ path: rel, present: false, bytes: null, mtime: null, sha256: null })
      continue
    }
    parsed.set(rel, parseEnvText(readFileSync(abs, 'utf8')))
    files.push({
      path: rel,
      present: true,
      bytes: statSync(abs).size,
      mtime: statSync(abs).mtime.toISOString(),
      sha256: sha256OfFile(abs),
    })
  }

  const keys: EnvKeyReading[] = ENV_KEYS.map((key) => {
    const presentIn: string[] = []
    const valueLengthByFile: Record<string, number> = {}
    const nonSecretValueByFile: Record<string, string> = {}
    const keepValue = (ENV_VALUE_KEYS as readonly string[]).includes(key)
    for (const rel of ['.env', '.env.test'] as const) {
      const value = parsed.get(rel)?.get(key)
      if (value === undefined) continue
      presentIn.push(rel)
      valueLengthByFile[rel] = value.length
      if (keepValue) nonSecretValueByFile[rel] = value
    }
    const reading: EnvKeyReading = { key, presentIn, valueLengthByFile }
    if (keepValue) reading.nonSecretValueByFile = nonSecretValueByFile
    return reading
  })

  return {
    files,
    keys,
    note:
      '读数来自文件文本（**本脚本不 import dotenv**）；每键按文件分别记"是否存在 + 值长度"，不记取值。' +
      '只有端点标识与枚举/数值型白名单键留取值。',
  }
}

/**
 * 静态核对测试包装器的**加载次序**（决定"测试档会不会继承 `.env` 的预算"）。
 *
 * 它回答的问题是计划书 §4 WP5 第 3 条要防的那种：
 * 「把 `.env.test` 当前的值当成代码缺省」。若 `.env.test` 不写某键，而包装器
 * 先加载 `.env`，那么**测试档实际拿到的是 `.env` 的值** —— 这件事必须是被记下来的
 * 事实，而不是靠人记得。
 */
function readWrapperEnvOrder(root: string): {
  wrapperFile: string
  baseLoaded: boolean
  overrideLoaded: boolean
  orderIsBaseThenOverride: boolean
  note: string
} {
  const rel = 'scripts/run-with-test-model.ts'
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    return {
      wrapperFile: rel,
      baseLoaded: false,
      overrideLoaded: false,
      orderIsBaseThenOverride: false,
      note: '包装器文件不存在 ⇒ 无法核对加载次序',
    }
  }
  const text = readFileSync(abs, 'utf8')
  const baseIndex = text.indexOf('config({ path: BASE_ENV })')
  const overrideIndex = text.indexOf('config({ path: TEST_ENV, override: true })')
  return {
    wrapperFile: rel,
    baseLoaded: baseIndex >= 0,
    overrideLoaded: overrideIndex >= 0,
    orderIsBaseThenOverride: baseIndex >= 0 && overrideIndex >= 0 && baseIndex < overrideIndex,
    note:
      '`config({path: BASE_ENV})` 在前、`config({path: TEST_ENV, override: true})` 在后 ⇒ ' +
      '**`.env` 是基线、`.env.test` 只覆盖它写了的键**。因此凡 `.env.test` 未写的键，' +
      '测试档实际继承的是 `.env` 的值（这不是主张"应该如此"，只是把它变成可判定的事实）。',
  }
}

// ---------------------------------------------------------------------------
// 与计划书的偏差（冲突登记，不静默覆盖）
// ---------------------------------------------------------------------------

interface Discrepancy {
  id: string
  subject: string
  planSays: string
  measured: string
  status: 'CONFIRMED-DIVERGENCE' | 'CONFIRMED-CONSISTENT' | 'UNVERIFIABLE'
  handling: string
}

function readDiscrepancies(root: string, env: { keys: EnvKeyReading[] }): Discrepancy[] {
  const out: Discrepancy[] = []
  const rollupKey = env.keys.find((entry) => entry.key === 'CHARACTER_ROLLUP_TOKENS')
  const inEnv = rollupKey?.presentIn.includes('.env') ?? false
  const inTest = rollupKey?.presentIn.includes('.env.test') ?? false
  const envValue = rollupKey?.nonSecretValueByFile?.['.env'] ?? null
  out.push({
    id: 'D-1',
    subject: 'CHARACTER_ROLLUP_TOKENS 的配置位置',
    planSays: '计划书 §1.1：「`.env` / `.env.test` 均已配置 `CHARACTER_ROLLUP_TOKENS=400`」',
    measured: `.env present=${String(inEnv)} value=${String(envValue)}；.env.test present=${String(inTest)}`,
    status: inEnv && !inTest ? 'CONFIRMED-DIVERGENCE' : 'CONFIRMED-CONSISTENT',
    handling:
      '按批准的计划：**只登记、不修改** `.env.test`（配置裁定属用户/并发会话）。' +
      'WP5 的两条预算臂必须**显式**给值（缺省档显式 0），不得依赖 `.env.test` 当前内容。',
  })

  const planFile = 'docs/m6.1/M6.1-DSH-Execution-Plan.md'
  out.push({
    id: 'D-2',
    subject: '计划书引用的 HEAD',
    planSays: '计划书 §1.1：「本轮初始只读核对 HEAD：59ffaa5655b48b5a923a097f5c7d6e6308c13982」',
    measured: `实测 HEAD = ${git(['rev-parse', 'HEAD']).trim()}（分支 ${git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()}）`,
    status: 'CONFIRMED-DIVERGENCE',
    handling: '以本 baseline 记录的 HEAD 为准；计划书要求开工时重新记录，不默认仍停在初始提交。',
  })

  const contractPath = 'docs/m6/M6-Acceptance-Contract.md'
  out.push({
    id: 'D-3',
    subject: 'G1 判定契约文件的位置',
    planSays: '计划书与立案多处引用 `M6-Acceptance-Contract.md`（未给目录）',
    measured: existsSync(join(root, contractPath)) ? `存在于 ${contractPath}` : '未在 docs/m6/ 下找到',
    status: existsSync(join(root, contractPath)) ? 'CONFIRMED-CONSISTENT' : 'UNVERIFIABLE',
    handling: '登记真实路径，供 WP1 引用；不复制、不改写。',
  })

  const planFilePath = join(root, planFile)
  out.push({
    id: 'D-4',
    subject: '计划书本身是否已提交',
    planSays: '计划书 §1.1 把本目录两份计划当作本轮交付物',
    measured: gitZ(['ls-files']).includes(planFile)
      ? '已跟踪'
      : '**未跟踪**（工作树里有，git 索引里没有）',
    status: gitZ(['ls-files']).includes(planFile) ? 'CONFIRMED-CONSISTENT' : 'CONFIRMED-DIVERGENCE',
    handling: '本轮把两份计划纳入 M6.1 可归属提交（连同 baseline 与契约）。',
  })

  out.push({
    id: 'D-5',
    subject: '测试包装器的 env 加载次序',
    planSays: 'AGENTS §8.1：「先加载 `.env`（基线）再用 `.env.test` 覆盖」',
    measured: JSON.stringify(readWrapperEnvOrder(root)),
    status: 'CONFIRMED-CONSISTENT',
    handling:
      '作为机器事实登记：凡 `.env.test` 未写的键，测试档继承 `.env`。' +
      '影响 WP5 的摘要两档设计（缺省档必须显式 0）。',
  })
  return out
}

// ---------------------------------------------------------------------------
// 旧证据索引（§9.2：旧 FAIL 与新 PASS 都保留，必须写明取代关系）
// ---------------------------------------------------------------------------

interface EvidenceEntry {
  subject: string
  path: string | null
  status: 'historical' | 'current' | 'unverified' | 'superseded'
  supersededBy?: string
  note?: string
}

const EVIDENCE_INDEX: EvidenceEntry[] = [
  {
    subject: 'M6.1 执行计划（本阶段的权威源）',
    path: 'docs/m6.1/M6.1-DSH-Execution-Plan.md',
    status: 'current',
    note: '状态 `PLAN READY / IMPLEMENTATION NOT STARTED`；本轮起进入 WP0',
  },
  {
    subject: 'M6.1 及后续技术债排期',
    path: 'docs/m6.1/M6.1-and-Later-Technical-Debt-Plan.md',
    status: 'current',
    note: 'TD-01…TD-21；M6.1 只接 TD-01…TD-05，其余登记不动',
  },
  {
    subject: 'M6-FMB-01 立案（假记忆边界）',
    path: 'docs/m6/M6-False-Memory-Boundary-Register.md',
    status: 'current',
    note: '硬顺序 ①判定契约 → ②量具有效性 → ③机器门/实现；本轮做 ①',
  },
  {
    subject: 'G1 人工复核发现（§6.1–§6.5 与 §7 结论）',
    path: 'docs/m6/G1-Acceptance-Report.md',
    status: 'current',
    note: 'G1 = PARTIAL；§6.1 的"旧 host 未接 memoryWriter/recall/actionWriter/rollup"是 WP1 的硬约束来源',
  },
  {
    subject: 'M6 判定载体',
    path: 'docs/m6/M6-Gate-Decision.md',
    status: 'current',
    note: 'M6 = PASS 是 `m6-complete` 提交上的历史读数；不因 M6.1 而改变',
  },
  {
    subject: 'M6 已知局限（§1 假记忆 / §6.1–6.2 TD-04）',
    path: 'docs/m6/M6-Known-Limitations.md',
    status: 'current',
  },
  {
    subject: 'M6 验收事实',
    path: 'docs/m6/M6-Acceptance-Report.md',
    status: 'current',
  },
  {
    subject: 'M6 验收契约（DESIGN FROZEN）',
    path: 'docs/m6/M6-Acceptance-Contract.md',
    status: 'current',
    note: 'G1 的评分范围以此为准；M6.1 不修改它',
  },
  {
    subject: 'WP9b 长对话本地材料（V1/V2/V3 全文，gitignored）',
    path: 'artifacts/m6/local/m6-wp9b-20260921-e869f29de85d',
    status: 'historical',
    note: 'WP1 的具名回归**只引用**这里的轮次与 sha256，不复制正文进 Git',
  },
  {
    subject: 'G1-A 盲审包（9 段窗口 + 75 条探针，gitignored）',
    path: 'artifacts/m6/local/g1-a-35415631e5bc/index.json',
    status: 'historical',
    note: '同一目录含 windows.json / false-memory-probes.json / hard-failures.json',
  },
  {
    subject: 'M6 WP0 基线（M6 自己的，历史）',
    path: 'artifacts/m6/m6-wp0-20260921-1165fedcdde2/baseline.json',
    status: 'historical',
    note: 'M6 的 baseline 不能被当作 M6.1 的基线；M6.1 另出 runId',
  },
  {
    subject: 'ADR-043 认知资格（DR-11：措辞层没有启发式守卫）',
    path: 'docs/adr/ADR-043-epistemic-requalification.md',
    status: 'current',
    note: 'M6.1 的"不许加正则当解"来自这里；变更须分配新 ADR',
  },
  {
    subject: '认知完整性（Sovereign Core 约束）',
    path: 'docs/architecture/cognitive-integrity.md',
    status: 'current',
    note: '§9 禁止伪造经历 · §16 自动路径同样受约束',
  },
  {
    subject: 'M6 门汇总（当时读数，非本轮刷新）',
    path: null,
    status: 'unverified',
    note: 'M6.1 不引用 M6 的汇总给自己背书；`m6:gates` 的当前读数由 WP7 自行重取',
  },
]

interface EvidenceReading extends EvidenceEntry {
  sha256: string | null
  bytes: number | null
  missing: boolean
}

function readEvidenceIndex(root: string): EvidenceReading[] {
  return EVIDENCE_INDEX.map((entry) => {
    if (entry.path === null) return { ...entry, sha256: null, bytes: null, missing: true }
    const abs = join(root, entry.path)
    if (!existsSync(abs)) return { ...entry, sha256: null, bytes: null, missing: true }
    // 目录型条目：按"目录内文件数"记，不用文件摘要
    if (statSync(abs).isDirectory()) {
      return { ...entry, sha256: null, bytes: null, missing: false }
    }
    return { ...entry, sha256: sha256OfFile(abs), bytes: statSync(abs).size, missing: false }
  })
}

// ---------------------------------------------------------------------------
// 本地材料索引（gitignored 的正文面：只列路径/大小/摘要，正文不进 Git）
// ---------------------------------------------------------------------------

interface LocalEvidenceIndex {
  root: string
  present: boolean
  fileCount: number
  totalBytes: number
  files: { path: string; bytes: number; sha256: string }[]
  note: string
}

function readLocalEvidenceIndex(root: string): LocalEvidenceIndex {
  const rel = 'artifacts/m6/local'
  const base = join(root, rel)
  if (!existsSync(base)) {
    return {
      root: rel,
      present: false,
      fileCount: 0,
      totalBytes: 0,
      files: [],
      note: '本地材料目录不存在 ⇒ WP1 的具名回归只能报 NOT RUN（不得重建冒充逐字重放）',
    }
  }
  const files: { path: string; bytes: number; sha256: string }[] = []
  let totalBytes = 0
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        walk(abs)
        continue
      }
      if (!dirent.isFile()) continue
      const size = statSync(abs).size
      totalBytes += size
      files.push({
        path: relative(base, abs).split(/[\\/]/).join('/'),
        bytes: size,
        sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
      })
    }
  }
  walk(base)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    root: rel,
    present: true,
    fileCount: files.length,
    totalBytes,
    files,
    note:
      '这份索引**只有路径/大小/摘要**，没有正文 —— 正文留在本地（gitignored），' +
      '提交进 Git 的只有可核验的引用。',
  }
}

// ---------------------------------------------------------------------------
// git 状态
// ---------------------------------------------------------------------------

interface DirtyPath {
  path: string
  status: string
  ownership: Ownership
}

interface GitState {
  branch: string
  head: string
  headShort: string
  mainSha: string
  aheadOfMain: number
  behindMain: number
  mainIsAncestor: boolean
  stashCount: number
  tags: { name: string; annotation: string }[]
  dirtyPaths: DirtyPath[]
  unknownDirtyPaths: number
  sharedDirtyPaths: number
  otherTaskDirtyPaths: number
}

function readGitState(): GitState {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const head = git(['rev-parse', 'HEAD']).trim()
  const mainSha = git(['rev-parse', 'main']).trim()
  const aheadOfMain = Number(git(['rev-list', '--count', 'main..HEAD']).trim())
  const behindMain = Number(git(['rev-list', '--count', 'HEAD..main']).trim())

  let mainIsAncestor = true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'HEAD'], { stdio: 'ignore' })
    commands.push({ cmd: 'git merge-base --is-ancestor main HEAD', exitCode: 0 })
  } catch {
    commands.push({ cmd: 'git merge-base --is-ancestor main HEAD', exitCode: 1 })
    mainIsAncestor = false
  }

  const stashCount = git(['stash', 'list']).split('\n').filter((line) => line.trim() !== '').length
  const tagLines = git(['tag', '--list', '-n1']).split('\n').filter((line) => line.trim() !== '')
  const tags = tagLines.map((line) => {
    const [name, ...rest] = line.trim().split(/\s+/)
    return { name: name ?? line.trim(), annotation: rest.join(' ') }
  })

  /*
   * ⚠️ 必须用 `-z`：默认的 `git status --porcelain` 会把非 ASCII 路径按
   * `core.quotepath` 转义成一个**带引号的假路径**，于是路径归属分类全部落空。
   * 同时加 `--no-renames`：重命名在 `-z` 模式下会多出一个 NUL 字段。
   */
  const dirtyPaths: DirtyPath[] = gitZ(['status', '--porcelain=v1', '--no-renames']).map((line) => {
    const status = line.slice(0, 2)
    const rawPath = line.slice(3)
    const path = rawPath.includes(' -> ') ? (rawPath.split(' -> ')[1] ?? rawPath) : rawPath
    return { path, status, ownership: classifyOwnership(path) }
  })

  return {
    branch,
    head,
    headShort: head.slice(0, 12),
    mainSha,
    aheadOfMain,
    behindMain,
    mainIsAncestor,
    stashCount,
    tags,
    dirtyPaths,
    unknownDirtyPaths: dirtyPaths.filter((entry) => entry.ownership === 'unknown').length,
    sharedDirtyPaths: dirtyPaths.filter(
      (entry) => entry.ownership === 'shared-m6.1-and-other-task'
    ).length,
    otherTaskDirtyPaths: dirtyPaths.filter((entry) => entry.ownership === 'other-task').length,
  }
}

// ---------------------------------------------------------------------------
// 并发窗口
// ---------------------------------------------------------------------------

interface ConcurrencyReading {
  status: 'clean' | 'unverified-writes'
  windows: { hours: number; files: { path: string; ownership: Ownership; mtime: string }[] }[]
  note: string
}

function readConcurrency(root: string): ConcurrencyReading {
  const tracked = gitZ(['ls-files'])
  const untracked = gitZ(['ls-files', '--others', '--exclude-standard'])
  const candidates: { rel: string; mtimeMs: number; mtime: string }[] = []
  for (const rel of [...new Set([...tracked, ...untracked])].sort()) {
    if (SOURCE_TREE_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    const stat = statSync(abs)
    candidates.push({ rel, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() })
  }
  const windows = [RECENT_WINDOW_HOURS, LONG_WINDOW_HOURS].map((hours) => {
    const cutoff = Date.now() - hours * 3600 * 1000
    return {
      hours,
      files: candidates
        .filter((entry) => entry.mtimeMs >= cutoff)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((entry) => ({
          path: entry.rel,
          ownership: classifyOwnership(entry.rel),
          mtime: entry.mtime,
        })),
    }
  })
  const shortWindow = windows[0]?.files ?? []
  const unexplained = shortWindow.filter((entry) => entry.ownership === 'unknown')
  return {
    status: unexplained.length === 0 ? 'clean' : 'unverified-writes',
    windows,
    note:
      '短窗内出现**归属未知**的改动才叫未核实的并发写入；M6.1 自产、共享文件与已登记的' +
      '他人任务路径都不算（它们分别登记，不混成一个数）。',
  }
}

// ---------------------------------------------------------------------------
// 量具自证（正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------

interface SelfTestCase {
  id: string
  kind: 'positive' | 'negative' | 'recovery' | 'negative-attribution' | 'negative-runid'
  proposition: string
  observed: string
  pass: boolean
}

function runSelfTest(): { cases: SelfTestCase[]; pass: boolean } {
  const cases: SelfTestCase[] = []
  const root = mkdtempSync(join(tmpdir(), 'm6.1-wp0-selftest-'))
  const writeProbeFiles = (second: string): void => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'alpha', 'utf8')
    writeFileSync(join(root, 'b.txt'), second, 'utf8')
  }
  try {
    writeProbeFiles('beta')
    const first = digestTree(root)
    cases.push({
      id: 'P1',
      kind: 'positive',
      proposition: '2 个已知文件 ⇒ measuredCount 恰为 2',
      observed: `measuredCount=${first.measuredCount}`,
      pass: first.measuredCount === 2,
    })

    writeProbeFiles('gamma')
    const mutated = digestTree(root)
    cases.push({
      id: 'P2',
      kind: 'positive',
      proposition: '改动 1 个文件的内容 ⇒ treeSha256 必须变',
      observed: `${first.treeSha256.slice(0, 16)}… → ${mutated.treeSha256.slice(0, 16)}…`,
      pass: first.treeSha256 !== mutated.treeSha256,
    })

    writeProbeFiles('beta')
    const restored = digestTree(root)
    cases.push({
      id: 'R1',
      kind: 'recovery',
      proposition: '内容还原 ⇒ treeSha256 回到原值（量具重新安静）',
      observed: `${restored.treeSha256.slice(0, 16)}…`,
      pass: restored.treeSha256 === first.treeSha256,
    })

    const empty = mkdtempSync(join(tmpdir(), 'm6.1-wp0-empty-'))
    try {
      let threw = false
      let message = ''
      try {
        digestTree(empty)
      } catch (error) {
        threw = error instanceof MeasurementInvalidError
        message = error instanceof Error ? error.message : String(error)
      }
      cases.push({
        id: 'N1',
        kind: 'negative',
        proposition: '空目录 ⇒ 必须抛 MeasurementInvalidError（measured_count = 0 不是 PASS）',
        observed: threw ? `抛了：${message.slice(0, 60)}…` : '**没有抛**（这是假绿）',
        pass: threw,
      })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }

    cases.push({
      id: 'N2',
      kind: 'negative-attribution',
      proposition: '证据归属：不存在的路径 ⇒ sha256OfFile 必须抛，不许记空串冒充"算过了"',
      observed: (() => {
        try {
          sha256OfFile(join(root, 'not-here.json'))
          return '**没有抛**（这是假绿）'
        } catch (error) {
          return error instanceof MeasurementInvalidError ? '抛了' : '抛了（但类型不对）'
        }
      })(),
      pass: (() => {
        try {
          sha256OfFile(join(root, 'not-here.json'))
          return false
        } catch (error) {
          return error instanceof MeasurementInvalidError
        }
      })(),
    })

    /*
     * M6.1 专属负控 ③：**同 runId 第二次必须被拒**（TD-04①）。
     * 没有这一条，"拒绝覆盖"就只是文档里的一句话。
     */
    const runRoot = mkdtempSync(join(tmpdir(), 'm6.1-wp0-runid-'))
    try {
      const runId = 'm6.1-wp0-20260922-958c6be6a213-0001'
      const firstDir = openRunDir(runRoot, runId)
      let threw = false
      try {
        openRunDir(runRoot, runId)
      } catch (error) {
        threw = error instanceof RunDirExistsError
      }
      cases.push({
        id: 'N3',
        kind: 'negative-runid',
        proposition: '同一个 runId 第二次 openRunDir ⇒ 必须抛 RunDirExistsError（拒绝覆盖旧读数）',
        observed: threw ? `抛了（${basename(firstDir)} 保留）` : '**没有抛**（旧读数会被覆盖）',
        pass: threw,
      })

      /*
       * M6.1 专属负控 ④：清单自摘要必须能识破"事后改一个字段"。
       * 用**真正的**判据函数（不是手抄一份等价逻辑）—— 否则这条负控只会证明
       * "我的手抄版会响"。
       */
      const sealed: Record<string, unknown> = sealManifest({ runId, a: 1 })
      const tampered: Record<string, unknown> = { ...sealed, a: 2 }
      const mismatchDetected = computeManifestPayloadSha256(tampered) !== tampered.payloadSha256
      cases.push({
        id: 'N4',
        kind: 'negative',
        proposition: '清单被事后改一个字段 ⇒ payloadSha256 必须对不上',
        observed: mismatchDetected ? '抓到了' : '**没抓到**（清单可被静默改写）',
        pass: mismatchDetected,
      })
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  } catch (error) {
    cases.push({
      id: 'X1',
      kind: 'negative',
      proposition: '自证过程本身不得抛异常',
      observed: error instanceof Error ? error.message : String(error),
      pass: false,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { cases, pass: cases.every((entry) => entry.pass) }
}

// ---------------------------------------------------------------------------
// 计分
// ---------------------------------------------------------------------------

interface CounterInput {
  evidence: EvidenceReading[]
  sourceTree: SourceTreeShape
  realDbDigest: TreeDigest
  localEvidence: LocalEvidenceIndex
  gitState: GitState
  concurrency: ConcurrencyReading
  envKeyCount: number
  discrepancies: Discrepancy[]
  /** 自证用例数（进 `counts.executed`，避免"检查了 0 项"） */
  selfTestSteps: number
  selfTestFailures: number
  sourceTreeDiff: { changedFiles: TreeDiffEntry[]; unexpected: number } | undefined
}

function buildCounters(input: CounterInput): Record<string, number> {
  const shortWindow = input.concurrency.windows.find((w) => w.hours === RECENT_WINDOW_HOURS)
  const longWindow = input.concurrency.windows.find((w) => w.hours === LONG_WINDOW_HOURS)
  /*
   * `executed / completed / skipped / failed` 是 M6 通用清单校验（`validateManifest`）要求的四个数，
   * 而且它有一条**真实事故形态**的判据：`executed > completed + skipped + failed`
   * ⇒ "失败轮次被丢弃"。
   *
   * 本量具的语义（必须写清楚，否则这四个数就是装饰）：
   *
   * ```text
   *   executed   = 本运行**执行过的核对步骤数**：自证用例 + 两类摘要 + 证据索引 + 偏差核对 + 两个并发窗口
   *   completed  = 完成的步骤数
   *   skipped    = 0（WP0 没有"跳过"这一档：任一必需检查失败都直接失败关闭）
   *   failed     = 0
   * ```
   *
   * 为什么可以断言 `completed === executed`：任何一步抛异常都会在**写清单之前**中止
   * （顶层失败关闭）⇒ "部分完成"这个状态**不可能**被落盘。这不是乐观假设，
   * 而是"清单只在全部步骤之后才原子晋升"的直接推论。
   */
  const executed =
    input.selfTestSteps +
    2 /* realDb 只读摘要 + mtime 观测 */ +
    2 /* sourceTree 摘要 + 原像 */ +
    input.evidence.length +
    input.discrepancies.length +
    input.concurrency.windows.length

  return {
    executed,
    completed: executed,
    skipped: 0,
    failed: 0,
    evidenceEntries: input.evidence.length,
    evidenceEntriesMissingPath: input.evidence.filter((entry) => entry.missing && entry.path !== null)
      .length,
    supersededEntries: input.evidence.filter((entry) => entry.status === 'superseded').length,
    unverifiedEntries: input.evidence.filter((entry) => entry.status === 'unverified').length,
    digestRealDbFiles: input.realDbDigest.measuredCount,
    digestRealDbBytes: input.realDbDigest.totalBytes,
    digestSourceTreeFiles: input.sourceTree.measuredCount,
    digestSourceTreeBytes: input.sourceTree.totalBytes,
    localEvidenceFiles: input.localEvidence.fileCount,
    localEvidenceBytes: input.localEvidence.totalBytes,
    envKeysRead: input.envKeyCount,
    discrepancies: input.discrepancies.length,
    discrepanciesDivergent: input.discrepancies.filter(
      (entry) => entry.status === 'CONFIRMED-DIVERGENCE'
    ).length,
    dirtyPaths: input.gitState.dirtyPaths.length,
    unknownDirtyPaths: input.gitState.unknownDirtyPaths,
    sharedDirtyPaths: input.gitState.sharedDirtyPaths,
    otherTaskDirtyPaths: input.gitState.otherTaskDirtyPaths,
    stashCount: input.gitState.stashCount,
    recentModifiedFilesShortWindow: shortWindow?.files.length ?? 0,
    recentModifiedFilesLongWindow: longWindow?.files.length ?? 0,
    recentUnknownOwnershipShortWindow:
      shortWindow?.files.filter((entry) => entry.ownership === 'unknown').length ?? 0,
    sourceTreeUnexpectedChanges: input.sourceTreeDiff?.unexpected ?? 0,
    sourceTreeExplainedChanges: input.sourceTreeDiff?.changedFiles.length ?? 0,
    measurementSelfTestFailures: input.selfTestFailures,
  }
}

function computeVerdict(
  counters: Record<string, number>,
  realDbUnchanged: boolean,
  diff: { changedFiles: TreeDiffEntry[]; unexpected: number }
): string {
  if ((counters.evidenceEntries ?? 0) < 8) return 'MEASUREMENT INVALID'
  if ((counters.digestRealDbFiles ?? 0) === 0) return 'MEASUREMENT INVALID'
  if ((counters.digestSourceTreeFiles ?? 0) === 0) return 'MEASUREMENT INVALID'
  if ((counters.measurementSelfTestFailures ?? 0) > 0) return 'MEASUREMENT INVALID'
  if (diff.unexpected > 0) return 'PARTIAL'
  if (!realDbUnchanged) return 'PARTIAL'
  if ((counters.unknownDirtyPaths ?? 0) > 0) return 'PARTIAL'
  if ((counters.localEvidenceFiles ?? 0) === 0) return 'PARTIAL'
  return 'BASELINE CAPTURED'
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  out: string | null
  phase: 'before' | 'after' | 'verify'
  supersedes: string[]
  supersedesReason: string | null
} {
  let out: string | null = null
  let phase: 'before' | 'after' | 'verify' = 'before'
  const supersedes: string[] = []
  let supersedesReason: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') {
      out = argv[index + 1] ?? null
      index += 1
      continue
    }
    if (arg === '--phase') {
      const value = argv[index + 1]
      if (value !== 'before' && value !== 'after' && value !== 'verify') {
        throw new Error(`--phase 只能是 before / after / verify，收到 ${String(value)}`)
      }
      phase = value
      index += 1
      continue
    }
    if (arg === '--supersedes') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        throw new Error('--supersedes 后面必须是旧的 runId 或证据目录路径')
      }
      /*
       * 只接受 runId 形状或 `artifacts/m6.1/<runId>` —— 这条记录的作用是
       * "**具名**一条被取代的读数"，所以它必须指向一个可核对的 runId，
       * 不允许写一句散文（散文无法核验，也就无法阻止"悄悄换掉"）。
       */
      const runId = value.includes('/') ? basename(value) : value
      if (!M6_1_RUN_ID_PATTERN.test(runId)) {
        throw new Error(`--supersedes 只接受 runId 或 artifacts/m6.1/<runId>（收到 ${value}）`)
      }
      supersedes.push(runId)
      index += 1
      continue
    }
    if (arg === '--supersedes-reason') {
      supersedesReason = argv[index + 1] ?? null
      index += 1
    }
  }
  return { out, phase, supersedes, supersedesReason }
}

/** `--out` 只接受 `artifacts/m6.1/<runId>` 这一种形状（运行目录的唯一权威）。 */
function runIdFromOut(root: string, out: string): string {
  const abs = resolve(root, out)
  const parent = resolve(root, 'artifacts', 'm6.1')
  const runId = basename(abs)
  if (resolve(abs, '..') !== parent) {
    throw new Error(
      `--out 必须是 artifacts/m6.1/<runId>（收到 ${out}）—— 运行目录的形状是判据的一部分，` +
        '不允许放到别处'
    )
  }
  if (!M6_1_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`runId 形状非法：${runId}（要求 ${String(M6_1_RUN_ID_PATTERN)}）`)
  }
  return runId
}

function main(): void {
  const root = resolve(process.cwd())
  const { out, phase, supersedes, supersedesReason } = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()

  const selfTest = runSelfTest()
  if (!selfTest.pass) {
    console.error('[m6.1-wp0] 量具自证失败 —— MEASUREMENT INVALID，不产出 baseline')
    for (const entry of selfTest.cases) {
      console.error(`  ${entry.pass ? 'PASS' : 'FAIL'} ${entry.id} ${entry.proposition}`)
    }
    process.exit(2)
  }

  const gitState = readGitState()

  // ---- verify 阶段 ----
  /*
   * 回答的是"**采样之后**工作树有没有再变，变的是不是只有 WP0 自产的纯文档"。
   *
   * 这一步存在的理由：采样必然发生在**最终一次文档编辑之前**（报告里要写 runId，
   * 而 runId 是采样时才生成的）。若只靠报告里写一句"后来只改了文档"，那就是
   * 一句**不可机器判定的口头声明**（AGENTS §6.2）。⇒ 把它做成第三次采样。
   */
  if (phase === 'verify') {
    if (out === null) {
      console.error('[m6.1-wp0] --phase verify 必须给出 --out artifacts/m6.1/<runId>')
      process.exit(2)
    }
    const runDir = resolve(root, out)
    const baselinePath = join(runDir, 'baseline.json')
    if (!existsSync(baselinePath)) {
      console.error(`[m6.1-wp0] --phase verify 需要先跑 before + after（缺 ${baselinePath}）`)
      process.exit(2)
    }
    const previous = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      digests: { sourceTree: { after: SourceTreeShape | null } }
    }
    const afterShape = previous.digests.sourceTree.after
    if (afterShape === null) {
      console.error('[m6.1-wp0] --phase verify 需要先跑 after（sourceTree.after 为空）')
      process.exit(2)
    }
    const afterIndex = parseSourceTreeIndex(readFileSync(join(runDir, afterShape.indexFile), 'utf8'))
    if (createHash('sha256')
      .update(
        [...afterIndex.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([rel, info]) => `${rel}\t${info.size}\t${info.sha256}\n`)
          .join(''),
        'utf8'
      )
      .digest('hex') !== afterShape.indexSha256) {
      throw new MeasurementInvalidError('MEASUREMENT INVALID：after 原像与它记录的 sha256 不一致')
    }

    const current = sourceTreeDigest(root, 'source-tree-index.verify.txt')
    writeFileSync(join(runDir, 'source-tree-index.verify.txt'), current.lines.join(''), 'utf8')
    const diff = diffSourceTree(afterIndex, current.perFile)
    const realDbNow = digestTree(join(root, REAL_DB_DIR))
    const realDbStable =
      (previous.digests as { realDb?: { after?: TreeDigest | null } }).realDb?.after?.treeSha256 ===
      realDbNow.treeSha256

    /*
     * ⚠️ **判据修正**（2026-09-23 实测逼出来的）：
     * 第一版只看运行相关树的差异就定 verdict，于是 `realDbUnchangedSinceAfterSample = false`
     * **不会**降档 —— 也就是说"真实库在采样后变了"这件事被记下来了，却**不影响结论**。
     * 那是把一条判据记录成"仅供参考"：本仓库最忌讳的形态。
     * ⇒ 真实库变了也必须降档：本次取样关于"真实库未变"的那部分主张不再成立。
     */
    const downgradeReason =
      diff.unexpected > 0
        ? '运行相关树在采样之后又变了（存在**非自产**改动）⇒ 本次取样的运行读数失效'
        : !realDbStable
          ? '真实库内容树摘要在采样之后变了 ⇒ 本次取样关于**真实库未变**的那部分主张不再成立'
          : null
    const verification = {
      verifiedAt: new Date().toISOString(),
      head: gitState.head,
      branch: gitState.branch,
      sampledTreeSha: afterShape.treeSha256,
      currentTreeSha: current.treeSha256,
      changedSinceAfterSample: diff.changedFiles,
      unexpectedChangedSinceAfterSample: diff.unexpected,
      realDbUnchangedSinceAfterSample: realDbStable,
      verdict: downgradeReason === null ? 'OK' : 'RUN-RELEVANT-TREE-CHANGED',
      downgradeReason,
      note:
        '`unexpectedChangedSinceAfterSample = 0` **且** `realDbUnchangedSinceAfterSample = true`' +
        ' 才判 OK。任一不成立 ⇒ 本次取样的相应主张失效，verdict 降档为 PARTIAL 并要求重采。',
    }

    const before = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>
    const downgraded =
      downgradeReason === null
        ? before.verdict
        : before.verdict === 'BASELINE CAPTURED'
          ? 'PARTIAL'
          : before.verdict
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...before, verification, verdict: downgraded }, null, 2)}\n`,
      'utf8'
    )
    const manifestPath = join(runDir, MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeManifestAtomic(runDir, {
      ...manifest,
      verification,
      verdict: downgraded,
      phases: [...((manifest.phases as unknown[]) ?? []), 'verify'],
      evidence: collectEvidence(root, runDir),
    })

    console.log(`[m6.1-wp0] phase=verify ${verification.verdict} verdict=${String(downgraded)}`)
    console.log(
      `  changedSinceAfterSample=${String(diff.changedFiles.length)} unexpected=${String(diff.unexpected)} realDbUnchanged=${String(realDbStable)}`
    )
    for (const entry of diff.changedFiles) {
      console.log(`    ${entry.kind} ${entry.ownership} ${entry.path}`)
    }
    process.exit(verification.verdict === 'OK' ? 0 : 2)
  }

  // ---- after 阶段 ----
  if (phase === 'after') {
    if (out === null) {
      console.error('[m6.1-wp0] --phase after 必须给出 --out artifacts/m6.1/<runId>')
      process.exit(2)
    }
    const runId = runIdFromOut(root, out)
    const runDir = resolve(root, out)
    const baselinePath = join(runDir, 'baseline.json')
    const manifestPath = join(runDir, MANIFEST_FILE)
    if (!existsSync(baselinePath) || !existsSync(manifestPath)) {
      console.error(`[m6.1-wp0] --phase after 需要先跑 before（缺 ${baselinePath} 或 ${manifestPath}）`)
      process.exit(2)
    }

    const previous = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      digests: {
        realDb: { before: TreeDigest; after: TreeDigest | null }
        sourceTree: { before: SourceTreeShape; after: SourceTreeShape | null }
      }
      counters: Record<string, number>
      measurementSelfTest: { cases: SelfTestCase[] }
    }

    // 先复核 before 的 sidecar 原像**没被事后改过**，再拿它做 diff
    const beforeIndexRel = previous.digests.sourceTree.before.indexFile
    const beforeIndexAbs = join(runDir, beforeIndexRel)
    if (!existsSync(beforeIndexAbs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：before 原像缺失 ${beforeIndexRel}`)
    }
    const beforeIndex = parseSourceTreeIndex(readFileSync(beforeIndexAbs, 'utf8'))
    const recomputed = createHash('sha256')
      .update(
        [...beforeIndex.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([rel, info]) => `${rel}\t${info.size}\t${info.sha256}\n`)
          .join(''),
        'utf8'
      )
      .digest('hex')
    if (recomputed !== previous.digests.sourceTree.before.indexSha256) {
      throw new MeasurementInvalidError(
        'MEASUREMENT INVALID：before 原像与它记录的 sha256 不一致（索引被改过，或写入时截断）'
      )
    }

    const afterIndexFile = 'source-tree-index.after.txt'
    const sourceTree = sourceTreeDigest(root, afterIndexFile)
    writeFileSync(join(runDir, afterIndexFile), sourceTree.lines.join(''), 'utf8')
    const diff = diffSourceTree(beforeIndex, sourceTree.perFile)

    const realDbAbs = join(root, REAL_DB_DIR)
    const realDbDigest = digestTree(realDbAbs)
    const realDbUnchanged = previous.digests.realDb.before.treeSha256 === realDbDigest.treeSha256
    const sourceUnchanged = previous.digests.sourceTree.before.treeSha256 === sourceTree.treeSha256

    const env = readEnvConfig(root)
    const localEvidence = readLocalEvidenceIndex(root)
    const concurrency = readConcurrency(root)
    const counters = {
      ...previous.counters,
      ...buildCounters({
        evidence: readEvidenceIndex(root),
        sourceTree: shapeOf(sourceTree),
        realDbDigest,
        localEvidence,
        gitState,
        concurrency,
        envKeyCount: env.keys.length,
        discrepancies: readDiscrepancies(root, env),
        selfTestSteps: selfTest.cases.length,
        selfTestFailures: selfTest.cases.filter((entry) => !entry.pass).length,
        sourceTreeDiff: diff,
      }),
      realDbStabilityUnchanged: realDbUnchanged ? 1 : 0,
      sourceTreeStabilityUnchanged: sourceUnchanged ? 1 : 0,
    }
    const verdict = computeVerdict(counters, realDbUnchanged, diff)

    const updated = {
      ...(JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>),
      phase: 'before+after',
      finishedAt: new Date().toISOString(),
      digests: {
        realDb: {
          definition: REAL_DB_DEFINITION,
          root: REAL_DB_DIR,
          before: previous.digests.realDb.before,
          after: realDbDigest,
          stability: realDbUnchanged ? 'unchanged' : 'changed',
          observationAfter: readRealDbMtimes(root),
          note: realDbUnchanged
            ? '两次只读摘要逐字相同：本轮 WP0 没有改变真实库字节（**不等于**"真实库这段历史完整"）'
            : '两次摘要不同：如实登记为变化，不得解释成"没被动过"',
        },
        sourceTree: {
          before: previous.digests.sourceTree.before,
          after: shapeOf(sourceTree),
          stability: sourceUnchanged ? 'unchanged' : 'changed',
          changedFiles: diff.changedFiles,
          unexpectedChangedFiles: diff.unexpected,
          note:
            '归属分类：m6.1-wp0 = 本阶段自产 · shared = 与并发会话共同持有 · ' +
            'other-task = 开工时已登记的他人未提交改动 · unknown = 需人工判定（会让 verdict 降档）',
        },
      },
      concurrencyAfter: concurrency,
      gitAfter: { branch: gitState.branch, head: gitState.head, dirtyPaths: gitState.dirtyPaths },
      localEvidenceAfter: localEvidence,
      counters,
      verdict,
    }
    writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeManifestAtomic(runDir, {
      ...manifest,
      finishedAt: new Date().toISOString(),
      phases: [...((manifest.phases as unknown[]) ?? []), 'after'],
      counts: counters,
      verdict,
      codeCommitAfter: gitState.head,
      runRelevantTreeShaAfter: sourceTree.treeSha256,
      evidence: collectEvidence(root, runDir),
    })

    console.log(`[m6.1-wp0] phase=after runId=${runId} verdict=${verdict}`)
    console.log(`  realDb      stability=${realDbUnchanged ? 'unchanged' : 'changed'}`)
    console.log(
      `  sourceTree  stability=${sourceUnchanged ? 'unchanged' : 'changed'} ` +
        `explained=${diff.changedFiles.length} unexpected=${diff.unexpected}`
    )
    for (const entry of diff.changedFiles) {
      console.log(`    ${entry.kind} ${entry.ownership} ${entry.path}`)
    }
    process.exit(verdict === 'BASELINE CAPTURED' ? 0 : 2)
  }

  // ---- before 阶段 ----
  const runId = out === null ? createRunId({ wpId: 'wp0', headShort: gitState.head }) : runIdFromOut(root, out)
  let runDir: string
  try {
    runDir = openRunDir(root, runId)
  } catch (error) {
    if (error instanceof RunDirExistsError) {
      console.error(`[m6.1-wp0] 失败关闭：${error.message}`)
      console.error('  同一 runId 的旧读数**不会被覆盖** —— 请换一个 runId（后缀不同即可）。')
      process.exit(2)
    }
    throw error
  }

  const baselinePath = join(runDir, 'baseline.json')
  const sourceTreeIndexFile = 'source-tree-index.before.txt'
  const sourceTree = sourceTreeDigest(root, sourceTreeIndexFile)
  writeFileSync(join(runDir, sourceTreeIndexFile), sourceTree.lines.join(''), 'utf8')

  const realDbAbs = join(root, REAL_DB_DIR)
  const realDbDigest = digestTree(realDbAbs)
  const realDbObservation = readRealDbMtimes(root)
  const env = readEnvConfig(root)
  const localEvidence = readLocalEvidenceIndex(root)
  const concurrency = readConcurrency(root)
  const evidence = readEvidenceIndex(root)
  const discrepancies = readDiscrepancies(root, env)

  const counters = buildCounters({
    evidence,
    sourceTree: shapeOf(sourceTree),
    realDbDigest,
    localEvidence,
    gitState,
    concurrency,
    envKeyCount: env.keys.length,
    discrepancies,
    selfTestSteps: selfTest.cases.length,
    selfTestFailures: selfTest.cases.filter((entry) => !entry.pass).length,
    sourceTreeDiff: undefined,
  })

  const baseline = {
    schemaVersion: 'm6.1-wp0-baseline@1',
    runId,
    phase: 'before',
    supersedes,
    supersedesNote:
      supersedesReason ??
      (supersedes.length === 0 ? '（未取代任何旧读数）' : '（取代关系见 criteriaCorrections）'),
    collectedAt: { startedAt, finishedAt: new Date().toISOString(), timezone: 'Asia/Shanghai' },
    git: gitState,
    digests: {
      realDb: {
        definition: REAL_DB_DEFINITION,
        root: REAL_DB_DIR,
        before: realDbDigest,
        after: null,
        stability: 'pending-after-sample',
        observationBefore: realDbObservation,
      },
      sourceTree: {
        before: shapeOf(sourceTree),
        after: null,
        stability: 'pending-after-sample',
      },
    },
    evidenceIndex: evidence,
    evidenceIndexMissingPaths: evidence
      .filter((entry) => entry.missing && entry.path !== null)
      .map((entry) => entry.path),
    localEvidenceIndex: localEvidence,
    configReadout: env,
    wrapperEnvOrder: readWrapperEnvOrder(root),
    discrepancies,
    concurrency,
    ownershipBoundaries: {
      m6_1AuthoredPrefixes: [...M6_1_AUTHORED_PREFIXES],
      sharedPaths: [...SHARED_PATHS],
      otherTaskPrefixes: [...OTHER_TASK_PREFIXES],
      note:
        '开工核对时工作树里已有**他人的未提交改动**（他人任务清单见 otherTaskPrefixes）。' +
        '本阶段**不还原、不提交、不覆盖**它们；`sharedPaths` 只做点状编辑。' +
        '`artifacts/` 兜底规则：该前缀下除 `artifacts/m6.1/` 以外的一切都归他人任务' +
        '（它们是别的里程碑的证据面，会被那一边的门重跑重新生成）。',
    },
    criteriaCorrections: [
      {
        id: 'CC-1',
        what: '脏文件归属分类器把 `artifacts/m5*`（7 个被重跑改写的证据 JSON）与 `scripts/inc-01-regression.ts` 记成了 unknown',
        why:
          'OTHER_TASK_PREFIXES 第一版只列了 `artifacts/m6/` 与 `artifacts/incidents/`，' +
          '漏了其它里程碑的证据面 ⇒ 8 条真实的并发改动会被当成"需人工判定的未知"，' +
          'verdict 会被错误地降成 PARTIAL（一种假红）。',
        how: '补 `artifacts/` 兜底前缀（在 `artifacts/m6.1/` 自产判定**之后**生效）与 `scripts/inc-01-`。',
        observedOn: 'm6.1-wp0-20260922-958c6be6a213-2765',
        note:
          '那一轮**保留在磁盘上**，并由本轮的 `supersedes` 具名取代；' +
          '不得按"修完判据就把旧读数删掉"的方式处理（AGENTS §6.6）。',
      },
      {
        id: 'CC-2',
        what: '脏文件归属分类器把 M6.1 **自己的语料目录** `evals/m6.1/` 记成了 unknown',
        why:
          'M6_1_AUTHORED_PREFIXES 第一版只列了 `docs/m6.1/` 与 `artifacts/m6.1/`，' +
          '忘了本轮新建的语料落在 `evals/m6.1/` ⇒ 1 条**自己产出的**改动被当成外部未知，' +
          '同样会把 verdict 错误降档（假红）。',
        how: '把 `evals/m6.1/` 加进 M6_1_AUTHORED_PREFIXES。',
        observedOn: 'm6.1-wp0-20260922-958c6be6a213-baa9',
        note:
          '同一个缺陷形态连续出现两次（都是"清单不完整 ⇒ 自己的产出被记成未知"）⇒ ' +
          '本节记录本身就是这个分类器**最脆弱的地方**的证据：它是人工枚举，不是推导出来的。',
      },
    ],
    measurementSelfTest: {
      pass: selfTest.pass,
      cases: selfTest.cases,
      note:
        '正控（数到了、且改字节必变）/ 负控（空目录必须抛）/ 恢复（还原后重新安静）/' +
        '证据归属负控 / **runId 拒绝覆盖** / **清单自摘要识破事后改写**',
    },
    openQuestions: [
      {
        id: 'OQ-1',
        question: `${REAL_DB_DIR} 的最新 mtime 是谁产生的写入？`,
        whyItMatters: '本阶段只能记录、不能解释；"没被动过"要靠摘要与 mtime 两件事分别说',
        whoCanAnswer: '用户（这段时间是否聊过天）/ 真实库账本（**需用户授权后**由 src/main.ts 读取）',
      },
      {
        id: 'OQ-2',
        question: '`.env.test` 是否应补 `CHARACTER_ROLLUP_TOKENS`？',
        whyItMatters:
          '包装器先 `.env` 后 `.env.test` 覆盖 ⇒ 该键未写时测试档继承 `.env` 的值。' +
          'WP5 的两档预算必须显式给值，不能依赖 `.env.test` 当前内容',
        whoCanAnswer: '用户 / 并发会话（配置裁定，M6.1 不擅自修改）',
      },
      {
        id: 'OQ-3',
        question: 'M6.1 是否另开 `feature/m6.1-*` 分支？',
        whyItMatters: '当前分支上有他人的未提交工作；切分支会扰动它',
        whoCanAnswer: '用户（等并发工作落定后再定）',
      },
    ],
    counters,
    verdict: 'PENDING-AFTER-SAMPLE',
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')

  writeManifestAtomic(runDir, {
    schemaVersion: 'm6.1-manifest@1',
    runId,
    testType:
      'M6.1 WP0 基线与前置核对（**只读**：不跑模型、不跑搜索、不打开真实库、不迁移、不快照）',
    phases: ['before'],
    startedAt,
    finishedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    codeCommit: gitState.head,
    head: gitState.head,
    branch: gitState.branch,
    baseBranch: { name: 'main', sha: gitState.mainSha, aheadOfMain: gitState.aheadOfMain },
    runRelevantTreeSha: sourceTree.treeSha256,
    workingTreeExceptions: gitState.dirtyPaths,
    commands,
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: safeVersion('git', ['--version']),
    },
    fixtureRubricThresholdHashes: {
      'evals/fixtures/m3.5/prompt-baseline.txt': safeHash(
        join(root, 'evals/fixtures/m3.5/prompt-baseline.txt')
      ),
      'evals/m3/baseline.json': safeHash(join(root, 'evals/m3/baseline.json')),
      'docs/m6/M6-False-Memory-Boundary-Register.md': safeHash(
        join(root, 'docs/m6/M6-False-Memory-Boundary-Register.md')
      ),
      'docs/m6/G1-Acceptance-Report.md': safeHash(join(root, 'docs/m6/G1-Acceptance-Report.md')),
      'docs/m6/M6-Acceptance-Contract.md': safeHash(
        join(root, 'docs/m6/M6-Acceptance-Contract.md')
      ),
    },
    nonSecretConfigFingerprint: { note: env.note, files: env.files, keys: env.keys },
    counts: counters,
    sandboxIdentity: {
      projectLgSandboxSet: process.env.PROJECT_LG_SANDBOX !== undefined,
      cwd: root,
    },
    realDbProtection: {
      definition: REAL_DB_DEFINITION,
      digestBefore: realDbDigest.treeSha256,
      measuredCount: realDbDigest.measuredCount,
      totalBytes: realDbDigest.totalBytes,
      excludedPaths: realDbDigest.excludedPaths,
      observationBefore: realDbObservation,
      note:
        '**只读**内容树摘要：本量具不打开 PGlite、不取租约、不调 initDatabase；`data/` 被 gitignore，' +
        '故"没被动过"只能靠摘要/mtime 证明，不能靠 git。',
    },
    exclusions: [...SOURCE_TREE_EXCLUDED_PREFIXES],
    measurementSelfTest: baseline.measurementSelfTest,
    contractVersion: M6_1_CONTRACT_VERSION,
    corpusVersion: M6_1_CORPUS_VERSION,
    instrumentVersion: M6_1_INSTRUMENT_VERSION,
    supersedes,
    supersedesNote:
      supersedesReason ??
      (supersedes.length === 0
        ? '本 runId 未取代任何旧读数（supersedes 为空数组是有意的写法，不是省略）'
        : '被取代的旧读数保留在磁盘上；取代关系必须能从这条记录追回去'),
    verdict: baseline.verdict,
    evidence: collectEvidence(root, runDir),
  })

  console.log(`[m6.1-wp0] phase=before runId=${runId}`)
  console.log(
    `  realDb     measuredCount=${realDbDigest.measuredCount} bytes=${realDbDigest.totalBytes} sha=${realDbDigest.treeSha256.slice(0, 16)}…`
  )
  console.log(
    `  sourceTree measuredCount=${sourceTree.measuredCount} bytes=${sourceTree.totalBytes} sha=${sourceTree.treeSha256.slice(0, 16)}…`
  )
  console.log(
    `  localEvidence=${localEvidence.fileCount} 文件 · evidence=${counters.evidenceEntries}（缺 ${counters.evidenceEntriesMissingPath}）· ` +
      `脏文件 ${counters.dirtyPaths}（未知 ${counters.unknownDirtyPaths} / 共享 ${counters.sharedDirtyPaths} / 他人 ${counters.otherTaskDirtyPaths}）`
  )
  console.log(`  偏差登记 ${counters.discrepancies} 条（其中分歧 ${counters.discrepanciesDivergent} 条）`)
  console.log(`  目录 = artifacts/m6.1/${runId}`)
  console.log(`  verdict=${baseline.verdict}（after 采样后再定案）`)
}

/*
 * 顶层失败关闭：任何异常都以**非零退出码**收场并打印干净的错误行，
 * 不留一个"看起来跑完了"的半成品证据目录。
 */
try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-wp0] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-wp0] 这是 MEASUREMENT INVALID，不是 PASS')
  }
  process.exit(2)
}
