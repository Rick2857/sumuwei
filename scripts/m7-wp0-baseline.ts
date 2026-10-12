/**
 * M7 WP0 —— **基线与前置核对**（`pnpm m7:wp0:baseline`）。
 *
 * ============================================================================
 *  这份脚本要测的命题（先写命题，再写量具）
 * ============================================================================
 * 「这份 baseline 描述的是**本 checkout 在当前 HEAD 上的真实状态**，
 *    而不是旧结果、别人的工作树、或一次空扫描。」
 *
 * 与 M6.1 的 WP0（`scripts/m6.1-wp0-baseline.ts`）是**同一个命题**，判据同源：
 *   ① runId 目录拒绝覆盖 + 清单原子晋升（TD-04①）；
 *   ② 脏文件**归属分类**（m7 自产 / 共享追加 / 并发已知 / 历史证据再生 / 未知），
 *      只有「未知」才降档 —— 别人的未提交改动是**事实**，不是污染。
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
 *   pnpm m7:wp0:baseline --out artifacts/m7/<runId> --phase before
 *   pnpm m7:wp0:baseline --out artifacts/m7/<runId> --phase after
 *   （before 建目录并落 baseline-before.json；after 落 baseline-after.json 并给最终判定）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  VOLATILE_EXCLUDED_PATHS,
  digestTree,
  type TreeDigest,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import { normalizeHeadShort } from './m6.1-evidence.ts'
import {
  M7_MANIFEST_VERSION,
  M7_RUN_PARENT,
  createM7RunId,
  openM7RunDir,
  runIdFromM7OutPath,
  writeM7Manifest,
} from './m7-evidence.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..')

/** 源码树摘要的排除前缀（目录级；证据目录是运行产物，不进源码树摘要）。 */
const SOURCE_TREE_EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'artifacts/m6/',
  'artifacts/m6.1/',
  'artifacts/m7/',
  'artifacts/.fast/',
] as const

/** 真实库只读摘要的目标（`data/` 已被 gitignore，git 看不见它）。 */
const REAL_DB_DIR = 'data/pglite'

/** mtime 观测窗口：最近 2 小时内有写入的文件数（并发会话活动的只读信号）。 */
const MTIME_WINDOW_MS = 2 * 60 * 60 * 1000

/** 允许进入证据的 `.env*` 键（与 M6.1 同一白名单口径）。 */
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

/** 留取值的非机密键（端点标识 / 枚举 / 数值预算，不是凭据）。 */
const ENV_VALUE_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'CHARACTER_WEB_SEARCH_MODE',
  'CHARACTER_ROLLUP_TOKENS',
] as const

/** M7 本 WP 自产文件的路径前缀（本轮新增的脚本 / 文档 / 证据）。 */
const M7_SELF_PREFIXES = ['scripts/m7-', 'docs/m7/', 'artifacts/m7/'] as const

/** 共享文件：M7 只做**点状追加**（package.json 追加 scripts 条目）。 */
const SHARED_APPENDED_PATHS = ['package.json'] as const

/**
 * 并发会话（INC-01 / 门执行器 / 测试加速）的已知未提交文件 —— L-M61-11/15 在案。
 * 这些是**别人的进行中工作**：保留、不提交、不还原；它们的存在不降档基线判定。
 */
const CONCURRENT_KNOWN_PREFIXES = [
  '.gitignore',
  'AGENTS.md',
  'README.md',
  'scripts/gates-run.ts',
  'scripts/gates/',
  'scripts/verify-gate-runner.ts',
  'scripts/verify-cli-exit-latency.ts',
  'scripts/inc-01-regression.ts',
  'src/infrastructure/runtime/guard-timers.ts',
  'docs/incidents/',
  'docs/adr/ADR-051-search-engine-recovery-proposal.md',
  'docs/m6.5/',
  'docs/苏沐薇-使用说明.txt',
  'docs/m6/M6-DSH-Execution-Plan.md',
  'artifacts/incidents/',
] as const

/** 会被门重跑再生的历史证据前缀（AGENTS §7：只还原白名单，不无差别 checkout）。 */
const REGENERATED_EVIDENCE_PREFIXES = [
  'artifacts/m4.5/',
  'artifacts/m5/',
  'artifacts/m5.1/',
  'artifacts/m5.5/',
  'artifacts/m5.5.1/',
  'artifacts/m6/',
  'artifacts/m6.1/',
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
  'minus excluded prefixes (paths use forward slashes; algorithm defined in scripts/m7-wp0-baseline.ts)'

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

type DirtyClass = 'm7-self' | 'shared-appended' | 'concurrent-known' | 'regenerated-evidence' | 'unknown'

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
  if (M7_SELF_PREFIXES.some((pre) => path.startsWith(pre))) return 'm7-self'
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
    'm7-self': 0,
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

function envReadings(): Record<string, Record<string, { present: boolean; valueLength: number; value?: string }>> {
  const out: Record<string, Record<string, { present: boolean; valueLength: number; value?: string }>> = {}
  for (const file of ['.env', '.env.test'] as const) {
    const abs = join(REPO_ROOT, file)
    const readings: Record<string, { present: boolean; valueLength: number; value?: string }> = {}
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
    out[file] = { __filePresent: { present: existsSync(abs), valueLength: 0 }, ...readings }
  }
  return out
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
  env: ReturnType<typeof envReadings>
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
  }
}

interface CheckResult {
  id: string
  label: string
  pass: boolean
  detail: string
}

function beforeChecks(c: Capture): CheckResult[] {
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
      detail: `m7-self=${c.dirty.counts['m7-self']} · shared=${c.dirty.counts['shared-appended']} · concurrent=${c.dirty.counts['concurrent-known']} · regenerated=${c.dirty.counts['regenerated-evidence']} · unknown=${c.dirty.counts.unknown}`,
    },
    {
      id: 'B5',
      label: '.env / .env.test 读数来自文件文本（不 import dotenv）',
      pass: true,
      detail: '.env present=' + String(c.env['.env'].__filePresent.present) + ' · .env.test present=' + String(c.env['.env.test'].__filePresent.present),
    },
  ]
}

function afterChecks(before: Capture, after: Capture): CheckResult[] {
  const sourceUnchanged = before.sourceTree.sha256 === after.sourceTree.sha256
  const dbUnchanged = before.realDb.digest.treeSha256 === after.realDb.digest.treeSha256
  return [
    ...beforeChecks(after),
    {
      id: 'A6',
      label: '真实库内容树摘要在采样窗口内逐字相同（唯一强失败条件）',
      pass: dbUnchanged,
      detail: `before=${before.realDb.digest.treeSha256.slice(0, 16)}… after=${after.realDb.digest.treeSha256.slice(0, 16)}…`,
    },
    {
      id: 'A7',
      label: '源码树摘要在采样窗口内相同（不同 ⇒ 并发写入，如实降档 PARTIAL）',
      pass: sourceUnchanged,
      detail: sourceUnchanged
        ? `同值 ${after.sourceTree.sha256.slice(0, 16)}…（${after.sourceTree.fileCount} 文件）`
        : `before=${before.sourceTree.sha256.slice(0, 16)}… after=${after.sourceTree.sha256.slice(0, 16)}…（并发会话在窗口内写入了源码树）`,
    },
    {
      id: 'A8',
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
    throw new Error('缺 --out artifacts/m7/<runId>（before 阶段可省略 --out，脚本会自动生成 runId 并打印）')
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.out === undefined) {
    if (args.phase !== 'before') {
      throw new Error('after 阶段必须给 --out artifacts/m7/<runId>（即 before 阶段打印的 runId）')
    }
    const { head } = readHead()
    const generated = createM7RunId({ wpId: 'wp0', headShort: head })
    console.log(`runId: ${generated}（自动生成；after 阶段请用 --out ${M7_RUN_PARENT}/${generated}）`)
    args.out = `${M7_RUN_PARENT}/${generated}`
  }
  const runId = runIdFromM7OutPath(REPO_ROOT, args.out ?? '')

  if (args.phase === 'before') {
    const dir = openM7RunDir(REPO_ROOT, runId)
    const cap = capture()
    const checks = beforeChecks(cap)
    const failed = checks.filter((c) => !c.pass).length
    const payload = {
      schema: 'm7-wp0-baseline@1',
      runId,
      phase: 'before',
      supersedes: args.supersedes ?? null,
      supersedesReason: args.supersedesReason ?? null,
      capture: cap,
      checks,
      verdict: 'PENDING-AFTER-SAMPLE',
    }
    writeFileSync(join(dir, 'baseline-before.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    writeM7Manifest(dir, {
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
  const dir = join(REPO_ROOT, M7_RUN_PARENT, runId)
  const beforePath = join(dir, 'baseline-before.json')
  if (!existsSync(beforePath)) {
    throw new Error(`after 阶段要求 ${beforePath} 已存在（先跑 --phase before）`)
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as { capture: Capture }
  const cap = capture()
  const checks = afterChecks(before.capture, cap)
  const failed = checks.filter((c) => !c.pass).length
  const dbCheck = checks.find((c) => c.id === 'A6')
  const unknownCheck = checks.find((c) => c.id === 'A8')
  const sourceCheck = checks.find((c) => c.id === 'A7')
  let verdict: string
  let exitCode: number
  if (dbCheck && !dbCheck.pass) {
    verdict = 'FAIL (REAL DB CHANGED DURING WP0)'
    exitCode = 2
  } else if ((unknownCheck && !unknownCheck.pass) || (sourceCheck && !sourceCheck.pass) || failed > 0) {
    verdict = 'PARTIAL'
    exitCode = 1
  } else {
    verdict = 'BASELINE CAPTURED'
    exitCode = 0
  }
  const payload = {
    schema: 'm7-wp0-baseline@1',
    runId,
    phase: 'after',
    supersedes: args.supersedes ?? null,
    supersedesReason: args.supersedesReason ?? null,
    before: { head: before.capture.head, sourceTree: before.capture.sourceTree, realDb: before.capture.realDb.digest },
    capture: cap,
    checks,
    verdict,
  }
  writeFileSync(join(dir, 'baseline-after.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
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
